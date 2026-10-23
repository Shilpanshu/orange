//! Video and audio conversion with FFmpeg (convert-av.ts + engines/ffmpeg.ts).
//! Speed first: streams whose codec already fits the target container are copied (a remux takes
//! seconds); only streams that don't fit are re-encoded, with quality-first defaults. H.264
//! re-encodes go to the graphics card (NVENC, Quick Sync, AMF) when one works, else libx264.
//!
//! Public helpers for tools: `probe(path, ctx)`, `ffmpeg(args, ctx, duration, range)`,
//! `gpu_encoder("h264" | "hevc")`, `gpu_quality_args`.

use super::{user, Ctx, Fail, R};
use crate::engines::{RunOpts, Stream};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Debug, Default)]
pub struct StreamInfo {
    pub index: i64,
    pub kind: String,
    pub codec: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub pix_fmt: Option<String>,
    pub rotation: i64,
    pub channels: Option<i64>,
    pub sample_rate: Option<i64>,
    pub sample_fmt: Option<String>,
    pub bit_depth: Option<i64>,
    pub is_cover: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeInfo {
    pub format: String,
    pub duration: f64,
    pub streams: Vec<StreamInfo>,
    pub video: Option<StreamInfo>,
    pub audio: Option<StreamInfo>,
    pub audios: Vec<StreamInfo>,
    pub subtitles: Vec<StreamInfo>,
    pub cover: Option<StreamInfo>,
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|x: &f64| x.is_finite())
}

fn rate(v: &Value) -> Option<f64> {
    let s = v.as_str()?;
    let (a, b) = s.split_once('/').unwrap_or((s, "1"));
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    let r = if b != 0.0 { a / b } else { a };
    (r.is_finite() && r > 0.0 && r < 1000.0).then_some(r)
}

/// Clockwise degrees a player turns the picture (iPhone portrait clips report 90).
fn rotation_of(s: &Value) -> i64 {
    let mut cw = num(&s["tags"]["rotate"]).unwrap_or(0.0);
    if let Some(list) = s["side_data_list"].as_array() {
        for sd in list {
            if let Some(r) = num(&sd["rotation"]) {
                cw = -r;
            }
        }
    }
    ((((cw / 90.0).round() as i64 * 90) % 360) + 360) % 360
}

/// Container and stream facts from ffprobe.
pub fn probe(path: &Path, ctx: &Ctx) -> R<ProbeInfo> {
    let a = vec!["-v".into(), "error".into(), "-print_format".into(), "json".into(), "-show_format".into(), "-show_streams".into(), path.to_string_lossy().into_owned()];
    let res = match ctx.run("ffprobe", &a, RunOpts::default()) {
        Ok(r) => r,
        Err(Fail::Cancelled) => return Err(Fail::Cancelled),
        Err(Fail::User(m)) => return Err(Fail::User(m)),
        Err(_) => return user("This file can't be read as audio or video. It may be damaged or incomplete."),
    };
    let j: Value = serde_json::from_slice(&res.stdout).unwrap_or(Value::Null);
    let streams: Vec<StreamInfo> = j["streams"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|s| {
            let kind = s["codec_type"].as_str().unwrap_or("").to_string();
            let mut st = StreamInfo {
                index: s["index"].as_i64().unwrap_or(0),
                codec: s["codec_name"].as_str().unwrap_or("unknown").to_string(),
                is_cover: kind == "video" && s["disposition"]["attached_pic"].as_i64() == Some(1),
                kind: kind.clone(),
                ..Default::default()
            };
            if kind == "video" {
                st.width = s["width"].as_i64();
                st.height = s["height"].as_i64();
                st.fps = rate(&s["avg_frame_rate"]).or_else(|| rate(&s["r_frame_rate"]));
                st.pix_fmt = s["pix_fmt"].as_str().map(String::from);
                st.rotation = rotation_of(s);
            } else if kind == "audio" {
                st.channels = s["channels"].as_i64();
                st.sample_rate = num(&s["sample_rate"]).map(|x| x as i64);
                st.sample_fmt = s["sample_fmt"].as_str().map(String::from);
                st.bit_depth = num(&s["bits_per_raw_sample"]).filter(|x| *x > 0.0).or_else(|| num(&s["bits_per_sample"]).filter(|x| *x > 0.0)).map(|x| x as i64);
            }
            st
        })
        .collect();
    let mut duration = num(&j["format"]["duration"]).unwrap_or(0.0);
    if duration <= 0.0 {
        duration = j["streams"].as_array().map(|a| a.iter().filter_map(|s| num(&s["duration"])).fold(0.0, f64::max)).unwrap_or(0.0);
    }
    let audios: Vec<StreamInfo> = streams.iter().filter(|s| s.kind == "audio").cloned().collect();
    Ok(ProbeInfo {
        format: j["format"]["format_name"].as_str().unwrap_or("").to_string(),
        duration,
        video: streams.iter().find(|s| s.kind == "video" && !s.is_cover).cloned(),
        audio: audios.first().cloned(),
        subtitles: streams.iter().filter(|s| s.kind == "subtitle").cloned().collect(),
        cover: streams.iter().find(|s| s.is_cover).cloned(),
        audios,
        streams,
    })
}

/// Runs ffmpeg with `-hide_banner -nostdin -y -loglevel error -progress pipe:1 -nostats` in front,
/// mapping its clock onto `range` of this file's bar. `duration` is the output's length in seconds.
pub fn ffmpeg(args: &[String], ctx: &Ctx, duration: f64, range: (f64, f64)) -> R<()> {
    ffmpeg_with(args, ctx, duration, range, None)
}

pub fn ffmpeg_with(args: &[String], ctx: &Ctx, duration: f64, range: (f64, f64), stdin: Option<&[u8]>) -> R<()> {
    let mut full: Vec<String> = vec!["-hide_banner".into()];
    if stdin.is_none() {
        full.push("-nostdin".into());
    }
    full.push("-y".into());
    if !args.iter().any(|a| a == "-loglevel" || a == "-v") {
        full.extend(["-loglevel".into(), "error".into()]);
    }
    full.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
    full.extend_from_slice(args);
    let (lo, hi) = range;
    let last = std::cell::Cell::new(-1.0f64);
    let report = |f: f64| {
        let v = lo + (hi - lo) * f.clamp(0.0, 1.0);
        if v - last.get() < 0.005 && f < 1.0 {
            return;
        }
        last.set(v);
        ctx.progress(v);
    };
    let on = |line: &str, s: Stream| {
        if s != Stream::Stdout {
            return;
        }
        if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if duration > 0.0 {
                if let Ok(us) = v.trim().parse::<f64>() {
                    report(us / 1e6 / duration);
                }
            }
        } else if line == "progress=end" {
            report(1.0);
        }
    };
    let r = ctx.run("ffmpeg", &full, RunOpts { on_line: Some(&on), stdin, no_stdout: true, ..Default::default() });
    if let Err(e) = r {
        // A failed or cancelled run must not leave a half-written file (the output is always last).
        if let Some(out) = args.last() {
            let p = Path::new(out);
            if p.is_absolute() {
                let _ = std::fs::remove_file(p);
            }
        }
        return Err(match e {
            Fail::Raw(m) => Fail::Raw(explain(&m)),
            other => other,
        });
    }
    report(1.0);
    Ok(())
}

/// Strips ffmpeg's "[component @ 0x...]" prefixes.
fn explain(m: &str) -> String {
    let mut s = m.trim();
    while s.starts_with('[') {
        match s.find(']') {
            Some(i) => s = s[i + 1..].trim_start(),
            None => break,
        }
    }
    let s = s.to_string();
    if s.chars().count() > 200 {
        format!("{}…", s.chars().take(200).collect::<String>())
    } else {
        s
    }
}

// ------------------------------------------------------------------ GPU encoders

/// Settings for a hardware encoder at roughly the quality of libx264 at `crf`.
pub fn gpu_quality_args(encoder: &str, crf: i64) -> Vec<String> {
    let q = (crf + 1).clamp(1, 51).to_string();
    let v: Vec<&str> = if encoder.ends_with("_nvenc") {
        vec!["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", &q, "-b:v", "0"]
    } else if encoder.ends_with("_qsv") {
        vec!["-preset", "medium", "-global_quality", &q]
    } else if encoder.ends_with("_amf") {
        vec!["-quality", "quality", "-rc", "qvbr", "-qvbr_quality_level", &q]
    } else {
        vec![]
    };
    v.into_iter().map(String::from).collect()
}

pub fn gpu_pix_fmt(encoder: &str) -> &'static str {
    if encoder.ends_with("_qsv") {
        "nv12"
    } else {
        "yuv420p"
    }
}

/// A one-second test encode with real settings; true when it produced a file.
fn gpu_works(ffmpeg: &Path, encoder: &str) -> bool {
    let out = std::env::temp_dir().join(format!("orange-gpu-probe-{}-{encoder}.mp4", std::process::id()));
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=1", "-c:v", encoder].iter().map(|s| s.to_string()).collect();
    a.extend(gpu_quality_args(encoder, 20));
    a.extend(["-pix_fmt".into(), gpu_pix_fmt(encoder).into(), "-f".into(), "mp4".into(), out.to_string_lossy().into_owned()]);
    let ok = crate::engines::run_tool_process(&ffmpeg.to_string_lossy(), &a, &RunOpts { timeout: Some(std::time::Duration::from_secs(20)), ..Default::default() }).is_ok()
        && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false);
    let _ = std::fs::remove_file(&out);
    ok
}

/// The working hardware encoder for "h264" or "hevc", detected once per run; None when there is
/// none, FFmpeg isn't downloaded yet, or Settings turned GPU encoding off.
pub fn gpu_encoder(codec: &str, ctx: &Ctx) -> Option<String> {
    static DETECTED: OnceLock<(Option<String>, Option<String>)> = OnceLock::new();
    if !ctx.prefs().gpu_encode || !crate::engines::ready("ffmpeg") {
        return None;
    }
    let (h264, hevc) = DETECTED.get_or_init(|| {
        let ff = crate::engines::bin("ffmpeg");
        let pick = |c: &str| {
            let cands: Vec<String> = ["nvenc", "qsv", "amf"].iter().map(|v| format!("{c}_{v}")).collect();
            let oks: Vec<bool> = std::thread::scope(|s| {
                let hs: Vec<_> = cands.iter().map(|e| s.spawn(|| gpu_works(&ff, e))).collect();
                hs.into_iter().map(|h| h.join().unwrap_or(false)).collect()
            });
            cands.into_iter().zip(oks).find(|(_, ok)| *ok).map(|(e, _)| e)
        };
        let r = (pick("h264"), pick("hevc"));
        crate::log::write(&format!("GPU video encoders: h264={:?} hevc={:?}", r.0, r.1));
        r
    });
    if codec == "hevc" {
        hevc.clone()
    } else {
        h264.clone()
    }
}

// ------------------------------------------------------------------ what fits where

const VIDEO_CONTAINERS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "wmv"];
const AUDIO_TARGETS: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff", "wma"];

fn video_copy(c: &str) -> &'static [&'static str] {
    match c {
        // Only codecs that play in the Windows and Apple built-in players.
        "mp4" => &["h264", "hevc", "av1"],
        "mov" => &["h264", "hevc", "prores", "mjpeg"],
        "mkv" => &["h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "mpeg2video", "mpeg1video", "prores", "mjpeg", "ffv1", "theora", "msmpeg4v3", "wmv3", "vc1"],
        "webm" => &["vp8", "vp9", "av1"],
        "avi" => &["mpeg4", "msmpeg4v3", "msmpeg4v2", "mjpeg"],
        _ => &["wmv1", "wmv2", "wmv3", "vc1"],
    }
}

fn audio_copy(c: &str) -> &'static [&'static str] {
    match c {
        "mp4" => &["aac", "mp3", "alac", "ac3", "eac3"],
        "mov" => &["aac", "mp3", "alac", "ac3", "eac3", "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_f32le"],
        "mkv" => &["aac", "mp3", "mp2", "opus", "vorbis", "flac", "ac3", "eac3", "dts", "truehd", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le"],
        "webm" => &["opus", "vorbis"],
        "avi" => &["mp3", "ac3", "pcm_s16le", "mp2"],
        _ => &["wmav1", "wmav2", "wmapro"],
    }
}

const H264_CRF: i64 = 20;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn video_encoder(c: &str, src: &StreamInfo, gpu: Option<&str>) -> Vec<String> {
    match c {
        "mp4" | "mov" | "mkv" => match gpu {
            Some(g) => {
                let mut v = vec![g.to_string()];
                v.extend(gpu_quality_args(g, H264_CRF));
                v.extend(s(&["-pix_fmt", gpu_pix_fmt(g), "-profile:v", "high"]));
                v
            }
            None => s(&["libx264", "-preset", "faster", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high"]),
        },
        "webm" => s(&["libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p"]),
        "avi" => s(&["mpeg4", "-q:v", "3", "-tag:v", "XVID", "-pix_fmt", "yuv420p"]),
        _ => {
            // wmv2 is quantiser based; scale the bitrate ceiling with the picture size.
            let px = (src.width.unwrap_or(1280) * src.height.unwrap_or(720)) as f64;
            let max = format!("{}M", ((px / 921_600.0) * 6.0).max(2.0).round() as i64);
            s(&["wmv2", "-q:v", "3", "-maxrate", &max, "-bufsize", "16M", "-pix_fmt", "yuv420p"])
        }
    }
}

fn audio_encoder(c: &str) -> Vec<String> {
    match c {
        "webm" => s(&["libopus", "-b:a", "160k"]),
        "avi" => s(&["libmp3lame", "-b:a", "192k"]),
        "wmv" => s(&["wmav2", "-b:a", "192k"]),
        _ => s(&["aac", "-b:a", "192k"]),
    }
}

/// Channel / sample-rate limits some encoders have.
fn audio_limits(enc: &str, a: &StreamInfo) -> Vec<String> {
    let mut out = vec![];
    let ch = a.channels.unwrap_or(2);
    if ["libmp3lame", "wmav2"].contains(&enc) && ch > 2 {
        out.extend(s(&["-ac", "2"]));
    }
    if ["libmp3lame", "wmav2", "aac"].contains(&enc) && a.sample_rate.unwrap_or(44100) > 48000 {
        out.extend(s(&["-ar", "48000"]));
    }
    if enc == "libvorbis" && ch > 8 {
        out.extend(s(&["-ac", "2"]));
    }
    // libopus only takes the Vorbis channel layouts; let ffmpeg remap 5.1(side) and friends.
    if enc == "libopus" && ch > 2 {
        out.extend(s(&["-filter", "aformat=channel_layouts=mono|stereo|3.0|quad|5.0|5.1|6.1|7.1"]));
    }
    out
}

// ------------------------------------------------------------------ public

pub fn convert(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let info = probe(input, ctx)?;
    ctx.progress(0.02);
    if target == "gif" {
        return Ok(vec![to_gif(input, &info, ctx)?]);
    }
    if AUDIO_TARGETS.contains(&target) {
        return Ok(vec![to_audio(input, &info, target, ctx)?]);
    }
    if VIDEO_CONTAINERS.contains(&target) {
        return Ok(vec![to_video(input, &info, target, ctx)?]);
    }
    user(format!("Can't convert to {}.", target.to_uppercase()))
}

fn to_video(input: &Path, info: &ProbeInfo, c: &str, ctx: &Ctx) -> R<PathBuf> {
    if info.video.is_none() && info.audio.is_none() {
        return user("This file has no video or audio in it.");
    }
    let out = ctx.out(input, c, "");
    let gpu = if info.video.is_some() && ["mp4", "mov", "mkv"].contains(&c) { gpu_encoder("h264", ctx) } else { None };
    let outs = out.to_string_lossy().into_owned();
    produce(&out, input, ctx, |allow_copy| {
        let run = |g: Option<&str>| {
            let mut a = video_args(input, info, c, allow_copy, g);
            a.push(outs.clone());
            ffmpeg(&a, ctx, info.duration, (0.02, 1.0))
        };
        let a = video_args(input, info, c, allow_copy, gpu.as_deref());
        match &gpu {
            Some(g) if a.contains(g) => match run(Some(g)) {
                Err(Fail::Cancelled) => Err(Fail::Cancelled),
                Err(e) => {
                    // Driver hiccup, unsupported size, too many sessions: the same job on the CPU.
                    crate::log::write(&format!("GPU encode failed; encoding on the CPU instead: {e}"));
                    let _ = std::fs::remove_file(&out);
                    run(None)
                }
                ok => ok,
            },
            _ => run(None),
        }
    })
}

fn video_args(input: &Path, info: &ProbeInfo, c: &str, allow_copy: bool, gpu: Option<&str>) -> Vec<String> {
    let mut a = vec!["-i".to_string(), input.to_string_lossy().into_owned(), "-map_metadata".into(), "0".into()];
    let single_audio = c == "avi" || c == "wmv";
    let audios: Vec<&StreamInfo> = if single_audio { info.audios.iter().take(1).collect() } else { info.audios.iter().collect() };
    if let Some(v) = &info.video {
        a.extend(["-map".into(), format!("0:{}", v.index)]);
        // mp4/mov keep the rotation flag on copy; the others would lose it, so re-encode (which bakes it in).
        let rotation_ok = v.rotation == 0 || c == "mp4" || c == "mov";
        // 10-bit / 4:2:2 / 4:4:4 H.264 plays in neither built-in player: only 8-bit 4:2:0 is copied.
        let pf = v.pix_fmt.as_deref().unwrap_or("yuv420p");
        let playable = v.codec != "h264" || c == "mkv" || pf == "yuv420p" || pf == "yuvj420p";
        if allow_copy && rotation_ok && playable && video_copy(c).contains(&v.codec.as_str()) {
            a.extend(s(&["-c:v", "copy"]));
            if v.codec == "hevc" && (c == "mp4" || c == "mov") {
                a.extend(s(&["-tag:v", "hvc1"]));
            }
        } else {
            a.push("-c:v".into());
            a.extend(video_encoder(c, v, gpu));
            if (v.width.unwrap_or(0) | v.height.unwrap_or(0)) & 1 == 1 {
                a.extend(s(&["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]));
            }
            let fps = v.fps.unwrap_or(30.0);
            if c == "avi" || c == "wmv" {
                a.extend(["-g".into(), ((fps * 2.0).round() as i64).to_string()]);
            }
            if fps > 120.0 && c != "mkv" {
                a.extend(s(&["-r", "60"]));
            }
        }
    }
    for (i, au) in audios.iter().enumerate() {
        a.extend(["-map".into(), format!("0:{}", au.index)]);
        if allow_copy && audio_copy(c).contains(&au.codec.as_str()) {
            a.extend([format!("-c:a:{i}"), "copy".into()]);
        } else {
            let enc = audio_encoder(c);
            a.push(format!("-c:a:{i}"));
            a.extend(enc.clone());
            for (k, x) in audio_limits(&enc[0], au).into_iter().enumerate() {
                a.push(if k % 2 == 0 { format!("{x}:a:{i}") } else { x });
            }
        }
    }
    // Subtitles: keep what the container can hold.
    let mut si = 0;
    for st in &info.subtitles {
        let text = ["subrip", "ass", "ssa", "mov_text", "webvtt", "text"].contains(&st.codec.as_str());
        let codec = if c == "mkv" {
            if !(text || ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"].contains(&st.codec.as_str())) {
                continue;
            }
            if st.codec == "mov_text" || st.codec == "text" { "srt" } else { "copy" }
        } else if (c == "mp4" || c == "mov") && text {
            "mov_text"
        } else if c == "webm" && text {
            "webvtt"
        } else {
            continue;
        };
        a.extend(["-map".into(), format!("0:{}", st.index), format!("-c:s:{si}"), codec.into()]);
        si += 1;
    }
    if c == "mp4" || c == "mov" {
        a.extend(s(&["-movflags", "+faststart"]));
    }
    a.extend(s(&["-map_chapters", if ["mkv", "mp4", "mov"].contains(&c) { "0" } else { "-1" }]));
    a
}

fn to_gif(input: &Path, info: &ProbeInfo, ctx: &Ctx) -> R<PathBuf> {
    let Some(v) = &info.video else { return user("This file has no video to turn into a GIF.") };
    let out = ctx.out(input, "gif", "");
    let fps = v.fps.unwrap_or(15.0).min(15.0);
    let shown_w = if v.rotation == 90 || v.rotation == 270 { v.height } else { v.width };
    let w = shown_w.unwrap_or(720).min(720);
    let fps_s = format!("{}", (fps * 1000.0).round() / 1000.0);
    // One pass: split the frames, build an optimal palette from them, then map onto it.
    let graph = format!("[0:v:0]fps={fps_s},scale={w}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle");
    let a = vec!["-i".into(), input.to_string_lossy().into_owned(), "-filter_complex".into(), graph, "-loop".into(), "0".into(), out.to_string_lossy().into_owned()];
    produce(&out, input, ctx, |_| ffmpeg(&a, ctx, info.duration, (0.02, 1.0)))
}

fn audio_copy_for(t: &str) -> &'static [&'static str] {
    match t {
        "mp3" => &["mp3"],
        "m4a" => &["aac", "alac"],
        "flac" => &["flac"],
        "ogg" => &["vorbis"],
        "opus" => &["opus"],
        "wma" => &["wmav2", "wmav1", "wmapro"],
        _ => &[],
    }
}

fn audio_encoder_for(t: &str, a: &StreamInfo) -> Vec<String> {
    // 24-bit output only when the source really is high-resolution lossless.
    let lossless = ["pcm_", "flac", "alac", "wavpack", "ape", "truehd", "tta", "mlp"].iter().any(|p| a.codec.starts_with(p));
    let sf = a.sample_fmt.as_deref().unwrap_or("");
    let deep = lossless && (a.bit_depth.unwrap_or(0) > 16 || (a.bit_depth.is_none() && (sf.starts_with("s32") || sf.starts_with("flt") || sf.starts_with("dbl"))));
    match t {
        "mp3" => s(&["libmp3lame", "-q:a", "2"]),
        "m4a" => s(&["aac", "-b:a", "256k"]),
        "wav" => s(&[if deep { "pcm_s24le" } else { "pcm_s16le" }]),
        "flac" => s(&["flac", "-compression_level", "5", "-sample_fmt", if deep { "s32" } else { "s16" }]),
        "ogg" => s(&["libvorbis", "-q:a", "6"]),
        "opus" => s(&["libopus", "-b:a", "160k", "-vbr", "on"]),
        "aiff" => s(&[if deep { "pcm_s24be" } else { "pcm_s16be" }]),
        _ => s(&["wmav2", "-b:a", "192k"]),
    }
}

fn to_audio(input: &Path, info: &ProbeInfo, t: &str, ctx: &Ctx) -> R<PathBuf> {
    let Some(a) = &info.audio else {
        return user(if info.video.is_some() { "This video has no audio track to extract." } else { "This file has no audio in it." });
    };
    let out = ctx.out(input, t, "");
    produce(&out, input, ctx, |allow_copy| {
        let mut args = vec!["-i".to_string(), input.to_string_lossy().into_owned(), "-map".into(), format!("0:{}", a.index), "-map_metadata".into(), "0".into()];
        if allow_copy && audio_copy_for(t).contains(&a.codec.as_str()) {
            args.extend(s(&["-c:a", "copy"]));
        } else {
            let enc = audio_encoder_for(t, a);
            args.push("-c:a".into());
            args.extend(enc.clone());
            args.extend(audio_limits(&enc[0], a));
        }
        // Keep album art where the format supports it.
        match &info.cover {
            Some(cv) if allow_copy && ["mp3", "m4a", "flac"].contains(&t) && ["mjpeg", "png"].contains(&cv.codec.as_str()) => {
                args.extend(["-map".into(), format!("0:{}", cv.index), "-c:v".into(), "copy".into(), "-disposition:v:0".into(), "attached_pic".into()]);
            }
            _ => args.push("-vn".into()),
        }
        if t == "mp3" {
            args.extend(s(&["-id3v2_version", "3"]));
        }
        if t == "m4a" {
            args.extend(s(&["-movflags", "+faststart"]));
        }
        args.extend(s(&["-sn", "-dn"]));
        args.push(out.to_string_lossy().into_owned());
        ffmpeg(&args, ctx, info.duration, (0.02, 1.0))
    })
}

/// Runs `job` writing straight to `out`. The first run may stream-copy; if it fails it runs once
/// more with everything re-encoded. A failed or cancelled run never leaves a half-written file.
fn produce(out: &Path, input: &Path, _ctx: &Ctx, job: impl Fn(bool) -> R<()>) -> R<PathBuf> {
    let r = (|| {
        match job(true) {
            Ok(()) => {}
            Err(Fail::Cancelled) => return Err(Fail::Cancelled),
            Err(e) => {
                crate::log::write(&format!("first ffmpeg attempt failed, re-encoding {}: {e}", input.display()));
                let _ = std::fs::remove_file(out);
                job(false)?;
            }
        }
        if std::fs::metadata(out).map(|m| m.len() == 0).unwrap_or(true) {
            return Err(Fail::Raw("ffmpeg produced no output.".into()));
        }
        Ok(out.to_path_buf())
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(out);
    }
    r
}
