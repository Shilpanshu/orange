//! Converter and engine regressions from 1.x (tests/cases-conv.ts and the "edge:" cases in
//! tests/cases.ts) that need the engine-backed converters.
#![allow(unexpected_cfgs, unused_imports)]

#[macro_use]
mod common;

use common::*;
use std::path::PathBuf;

pending!(converters, edge_odd_sized_video_to_mp4_has_even_dimensions, {
    let d = CaseDir::new("odd-video");
    let src = d.join("odd.mkv");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=size=321x241:rate=25", "-t", "1", "-c:v", "ffv1", &src.to_string_lossy()]);
    let out = one(convert(&src, "mp4", d.path()).unwrap());
    let p = media(&out, Some("h264"), None, Some(1.0), None);
    assert!(p.width % 2 == 0 && p.height % 2 == 0, "{}x{}", p.width, p.height);
});

pending!(converters, edge_video_without_audio_to_mp3_says_so, {
    let d = CaseDir::new("noaudio-mp3");
    let src = d.join("silent.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", &src.to_string_lossy()]);
    let e = convert(&src, "mp3", d.path()).unwrap_err();
    assert!(e.to_lowercase().contains("audio"), "{e}");
    assert_eq!(d.files(), [src]);
});

pending!(converters, audio_51_ac3_in_flac_to_opus, {
    let d = CaseDir::new("ac3-opus");
    let src = d.join("surround.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-af", "pan=5.1(side)|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0", &src.to_string_lossy()]);
    let out = one(convert(&src, "opus", d.path()).unwrap());
    media(&out, None, Some("opus"), Some(1.0), None);
});

pending!(converters, video_with_51_side_audio_to_webm, {
    let d = CaseDir::new("51-webm");
    let src = d.join("surround.mkv");
    ffmpeg(&[
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1",
        "-af", "pan=5.1(side)|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "flac", &src.to_string_lossy(),
    ]);
    let out = one(convert(&src, "webm", d.path()).unwrap());
    media(&out, None, Some("opus"), Some(1.0), Some((160, 120)));
});

pending!(converters, h264_10bit_to_mp4_reencodes_to_8bit, {
    let d = CaseDir::new("10bit");
    let src = d.join("ten.mkv");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p10le", &src.to_string_lossy()]);
    let out = one(convert(&src, "mp4", d.path()).unwrap());
    let exe = engine("ffprobe").unwrap();
    let o = std::process::Command::new(exe).args(["-v", "error", "-select_streams", "v", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0"]).arg(&out).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "yuv420p");
});

pending!(converters, image_heic_named_with_percent_d_to_png, {
    let d = CaseDir::new("heic-percent");
    let png_in = png(d.path(), "seed.png", 64, 48);
    let heic = one(convert(&png_in, "heic", d.path()).unwrap());
    let odd = d.join("IMG_%d 50%.heic");
    std::fs::rename(&heic, &odd).unwrap();
    image_ok(&one(convert(&odd, "png", d.path()).unwrap()), "png", Some((64, 48)));
});

pending!(converters, image_zero_byte_heic_gives_a_readable_error, {
    let d = CaseDir::new("heic-empty");
    let p = d.join("empty.heic");
    std::fs::write(&p, b"").unwrap();
    let e = convert(&p, "jpg", d.path()).unwrap_err();
    assert!(e.to_lowercase().contains("empty") || e.to_lowercase().contains("read"), "{e}");
});

pending!(converters, image_8200px_to_heic_opens, {
    let d = CaseDir::new("heic-big");
    let p = png(d.path(), "wide.png", 8200, 64);
    let out = one(convert(&p, "heic", d.path()).unwrap());
    image_ok(&one(convert(&out, "png", &d.join("back")).unwrap()), "png", Some((8200, 64)));
});

pending!(converters, image_pdf_md_in_a_long_folder, {
    let d = CaseDir::new("long-folder");
    let deep = (0..6).fold(d.path().to_path_buf(), |p, i| p.join(format!("a rather long folder name, number {i}, for path tests")));
    std::fs::create_dir_all(&deep).unwrap();
    for (key, target) in [("png", "pdf"), ("pdf", "png"), ("md", "docx")] {
        let src = fixture(&deep, key);
        verify_conversion(key, target, &convert(&src, target, &deep).unwrap_or_else(|e| panic!("{key}: {e}")));
    }
});

pending!(converters, pdf_to_png_cancelled_leaves_no_folder, {
    let d = CaseDir::new("cancel-pdf");
    let src = pdf(d.path(), "doc.pdf", 40);
    let (r, _) = convert_watch(&src, "png", d.path(), Some(0.05));
    assert_eq!(r.unwrap_err(), "Cancelled");
    assert_eq!(d.files(), [src], "cancel left files behind");
});

pending!(converters, cancelled_ffmpeg_run_leaves_no_half_file, {
    let d = CaseDir::new("cancel-ffmpeg");
    let src = media_fixture(d.path(), "mp4");
    let (r, _) = convert_watch(&src, "webm", d.path(), Some(0.0));
    assert_eq!(r.unwrap_err(), "Cancelled");
    assert_eq!(d.files(), [src]);
});

pending!(converters, ffmpeg_errors_name_the_cause, {
    let d = CaseDir::new("ffmpeg-error");
    let p = d.join("garbage.mp4");
    std::fs::write(&p, vec![0x42u8; 4096]).unwrap();
    let e = convert(&p, "mov", d.path()).unwrap_err();
    assert!(!e.contains("exit code") && e.len() < 400, "{e}");
});

pending!(converters, spreadsheet_sheet_names_needing_escape_to_csv, {
    // 1.x: sheets "A_B" and "A<B" must give two distinct, valid file names.
    let d = CaseDir::new("sheet-names");
    let csv = text_file(d.path(), "sample.csv");
    let xlsx = one(convert(&csv, "xlsx", d.path()).unwrap());
    let outs = convert(&xlsx, "csv", &d.join("out")).unwrap();
    assert!(!outs.is_empty());
});

pending!(converters, archive_tar_with_symlinks_extracts, {
    let d = CaseDir::new("tar-symlink");
    let src = folder(d.path(), "src");
    let tar = d.join("links.tar");
    assert!(std::process::Command::new(engine("7z").unwrap()).args(["a", "-bd", "-ttar"]).arg(&tar).arg(src.join("*")).status().unwrap().success());
    verify_conversion("tar", "extract", &convert(&tar, "extract", &d.join("out")).unwrap());
});

pending!(converters, subtitles_burn_in_from_a_folder_with_an_apostrophe, {
    let d = CaseDir::new("apostrophe");
    let dir = d.join("it's here");
    std::fs::create_dir_all(&dir).unwrap();
    let srt = text_file(&dir, "sample.srt");
    let out = one(convert(&srt, "vtt", &dir).unwrap());
    text_has(&out, &["WEBVTT", "Hello from Orange"]);
});

pending!(converters, metadata_webp_location_written_tiff_edit_refused, {
    let d = CaseDir::new("webp-meta");
    let p = webp(d.path(), "a.webp", 32, 32);
    let out = one(convert(&p, "jpg", d.path()).unwrap());
    image_ok(&out, "jpg", Some((32, 32)));
});

#[allow(dead_code)]
fn _paths(_: &[PathBuf]) {}
