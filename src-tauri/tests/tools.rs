//! The tool cases of 1.x (`tool` and `instant` groups in tests/cases.ts, plus the regressions in
//! tests/cases-tools.ts), against the planned `tools::run_tool`. All wait on the tools port.
//! Cases that need FFmpeg / 7-Zip / Ghostscript use the vendored engines (`common::engine`).
#![allow(unexpected_cfgs, unused_imports)]

#[macro_use]
mod common;

use common::*;
use serde_json::json;
use std::path::{Path, PathBuf};

#[cfg(orange_tools)]
fn t(id: &str, inputs: &[PathBuf], opts: serde_json::Value, d: &CaseDir) -> Vec<PathBuf> {
    tool(id, inputs, opts, d.path()).unwrap_or_else(|e| panic!("{id}: {e}"))
}

#[cfg(orange_tools)]
fn rejects(r: Result<Vec<PathBuf>, String>, needle: &str) {
    let e = r.expect_err("expected the tool to fail");
    assert!(e.to_lowercase().contains(&needle.to_lowercase()), "error {e:?} lacks {needle:?}");
}

#[cfg(orange_tools)]
fn name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}

// ---------------------------------------------------------------- instant

pending!(tools, extract_archive_zip, {
    let d = CaseDir::new("extract-zip");
    let outs = t("extractArchive", &[zip(d.path(), "files.zip")], json!({}), &d);
    verify_conversion("zip", "extract", &outs);
});

pending!(tools, extract_archive_7z_and_targz_together, {
    let d = CaseDir::new("extract-two");
    let src = folder(d.path(), "src");
    let sz = engine("7z").expect("7z");
    let a = d.join("files.7z");
    let b = d.join("files.tar.gz");
    assert!(std::process::Command::new(&sz).args(["a", "-bd"]).arg(&a).arg(src.join("*")).status().unwrap().success());
    let tar = d.join("files.tar");
    assert!(std::process::Command::new(&sz).args(["a", "-bd", "-ttar"]).arg(&tar).arg(src.join("*")).status().unwrap().success());
    assert!(std::process::Command::new(&sz).args(["a", "-bd", "-tgzip"]).arg(&b).arg(&tar).status().unwrap().success());
    let outs = t("extractArchive", &[a, b], json!({}), &d);
    assert_eq!(outs.len(), 2);
    for o in outs {
        verify_conversion("7z", "extract", &[o]);
    }
});

// ---------------------------------------------------------------- compress

pending!(tools, compress_image_jpg_quality_60, {
    let d = CaseDir::new("compress-jpg");
    let src = jpg(d.path(), "photo.jpg", 640, 480);
    let out = one(t("compress", &[src.clone()], json!({ "image": { "mode": "quality", "quality": 60, "strip": true } }), &d));
    assert_eq!(name(&out), "photo compressed.jpg");
    assert!(size_of(&out) < size_of(&src));
    image_ok(&out, "jpg", Some((640, 480)));
    assert!(!std::fs::read(&out).unwrap().windows(4).any(|w| w == b"Exif"), "metadata not stripped");
});

pending!(tools, compress_image_target_size, {
    let d = CaseDir::new("compress-size");
    let out = one(t("compress", &[png(d.path(), "sample.png", 640, 480)], json!({ "image": { "mode": "size", "targetBytes": 60000 } }), &d));
    assert!(size_of(&out) as f64 <= 60000.0 * 1.05, "{} bytes", size_of(&out));
    image_ok(&out, "png", None);
});

pending!(tools, compress_video_preset_small, {
    let d = CaseDir::new("compress-video");
    let src = media_fixture(d.path(), "mp4");
    let out = one(t("compress", &[src.clone()], json!({ "video": { "mode": "preset", "preset": "small" } }), &d));
    assert!(size_of(&out) < size_of(&src));
    media(&out, Some("h264"), Some("aac"), Some(3.0), Some((320, 240)));
});

pending!(tools, compress_audio_wav_to_m4a_128k, {
    let d = CaseDir::new("compress-audio");
    let src = wav(d.path(), "tone.wav", 3.0, 44100, 2);
    let out = one(t("compress", &[src.clone()], json!({ "audio": { "kbps": 128 } }), &d));
    assert!(size_of(&out) < size_of(&src));
    media(&out, None, Some("aac"), Some(3.0), None);
});

pending!(tools, compress_pdf_ebook, {
    let d = CaseDir::new("compress-pdf");
    // A photo-heavy PDF: Make PDF from a large image, then compress it.
    let big = png(d.path(), "big.png", 2400, 1800);
    let src = one(t("createPdf", &[big], json!({ "page": "a4", "orientation": "auto", "margin": 0 }), &d));
    let out = one(t("compress", &[src.clone()], json!({ "pdf": { "level": "ebook" } }), &d));
    assert!(size_of(&out) < size_of(&src) / 2, "downsampling did not run");
    assert_eq!(pdf_pages(&out), 1);
});

pending!(tools, compress_folder_to_zip, {
    let d = CaseDir::new("compress-folder");
    let out = one(t("compress", &[folder(d.path(), "Folder")], json!({}), &d));
    verify_conversion("folder", "zip", &[out]);
});

// ---------------------------------------------------------------- video

pending!(tools, trim_video_precise, {
    let d = CaseDir::new("trim-precise");
    let out = one(t("trimVideo", &[media_fixture(d.path(), "mp4")], json!({ "start": 0.5, "end": 2.0, "mode": "precise" }), &d));
    assert!(name(&out).ends_with(" trimmed.mp4"), "{}", name(&out));
    media(&out, Some("h264"), Some("aac"), Some(1.5), Some((320, 240)));
});

pending!(tools, trim_video_fast_stream_copy, {
    let d = CaseDir::new("trim-fast");
    let out = one(t("trimVideo", &[media_fixture(d.path(), "mp4")], json!({ "start": 0, "end": 2.0, "mode": "fast" }), &d));
    media(&out, Some("h264"), Some("aac"), Some(2.0), None);
});

pending!(tools, join_videos_fast_path, {
    let d = CaseDir::new("join-fast");
    let out = one(t("joinVideos", &[media_fixture(d.path(), "mp4"), media_fixture(d.path(), "mp4b")], json!({}), &d));
    media(&out, Some("h264"), Some("aac"), Some(5.0), Some((320, 240)));
});

pending!(tools, join_videos_mp4_and_mov_reencode, {
    let d = CaseDir::new("join-reencode");
    let out = one(t("joinVideos", &[media_fixture(d.path(), "mp4b"), media_fixture(d.path(), "mov")], json!({ "reencode": true }), &d));
    media(&out, Some("h264"), Some("aac"), Some(5.0), Some((320, 240)));
});

pending!(tools, crop_video_160x120, {
    let d = CaseDir::new("crop-video");
    let out = one(t("cropVideo", &[media_fixture(d.path(), "mp4")], json!({ "x": 80, "y": 60, "w": 160, "h": 120 }), &d));
    media(&out, Some("h264"), None, Some(3.0), Some((160, 120)));
});

pending!(tools, speed_video_2x, {
    let d = CaseDir::new("speed-video");
    let out = one(t("speedVideo", &[media_fixture(d.path(), "mp4")], json!({ "speed": 2 }), &d));
    media(&out, Some("h264"), Some("aac"), Some(1.5), None);
});

pending!(tools, video_frames_two, {
    let d = CaseDir::new("frames");
    let outs = t("videoFrames", &[media_fixture(d.path(), "mp4")], json!({ "times": [0.5, 1.5] }), &d);
    let files: Vec<PathBuf> = outs.iter().flat_map(|o| if o.is_dir() { files_under(o) } else { vec![o.clone()] }).collect();
    assert_eq!(files.len(), 2);
    for f in files {
        image_ok(&f, "png", Some((320, 240)));
    }
});

pending!(tools, split_video_three_parts, {
    let d = CaseDir::new("split-video");
    let outs = t("splitVideo", &[media_fixture(d.path(), "mp4")], json!({ "parts": 3 }), &d);
    let parts: Vec<PathBuf> = outs.iter().flat_map(|o| if o.is_dir() { files_under(o) } else { vec![o.clone()] }).filter(|f| matches!(ext_lower(f).as_str(), "mp4" | "mkv" | "mov")).collect();
    assert_eq!(parts.len(), 3);
    let total: f64 = parts.iter().map(|p| media(p, Some("h264"), None, None, None).duration).sum();
    assert!((total - 3.0).abs() < 0.4, "parts add up to {total} s");
});

pending!(tools, redact_video_one_box, {
    let d = CaseDir::new("redact-video");
    let out = one(t("redactVideo", &[media_fixture(d.path(), "mp4")], json!({ "boxes": [{ "x": 10, "y": 10, "w": 100, "h": 80, "start": 0, "end": 3, "style": "blur" }] }), &d));
    media(&out, Some("h264"), None, Some(3.0), Some((320, 240)));
});

// ---------------------------------------------------------------- audio

pending!(tools, normalize_audio_minus_16_lufs, {
    let d = CaseDir::new("normalize");
    let out = one(t("normalizeAudio", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "I": -16, "TP": -1.5, "LRA": 11 }), &d));
    media(&out, None, None, Some(3.0), None);
});

pending!(tools, trim_audio, {
    let d = CaseDir::new("trim-audio");
    let out = one(t("trimAudio", &[media_fixture(d.path(), "mp3")], json!({ "start": 0.5, "end": 2.5 }), &d));
    media(&out, None, Some("mp3"), Some(2.0), None);
});

pending!(tools, audio_channels_to_mono, {
    let d = CaseDir::new("mono");
    let out = one(t("audioChannels", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "output": "mono" }), &d));
    assert_eq!(media(&out, None, None, Some(3.0), None).channels, 1);
});

pending!(tools, bleep_audio, {
    let d = CaseDir::new("bleep");
    let out = one(t("bleepAudio", &[media_fixture(d.path(), "mp3")], json!({ "ranges": [{ "start": 1.0, "end": 1.5 }] }), &d));
    media(&out, None, None, Some(3.0), None);
});

pending!(tools, join_audio_two_mp3, {
    let d = CaseDir::new("join-audio");
    let out = one(t("joinAudio", &[media_fixture(d.path(), "mp3"), media_fixture(d.path(), "mp3b")], json!({}), &d));
    media(&out, None, Some("mp3"), Some(5.0), None);
});

pending!(tools, audio_to_video_waveform, {
    let d = CaseDir::new("visualize");
    let out = one(t("audioToVideo", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "style": "wave", "size": "square" }), &d));
    media(&out, Some("h264"), Some("aac"), Some(3.0), Some((1080, 1080)));
});

#[cfg(orange_tools)]
fn cues() -> serde_json::Value {
    json!([{ "start": 0.5, "end": 2.0, "text": "Hello from Orange" }, { "start": 2.2, "end": 2.9, "text": "Second line" }])
}

pending!(tools, subtitles_from_cues_to_srt, {
    let d = CaseDir::new("subs-srt");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "srt" }), &d));
    text_has(&out, &["Hello from Orange", "00:00:00,500 --> 00:00:02,000"]);
});

pending!(tools, subtitles_from_cues_to_track, {
    let d = CaseDir::new("subs-track");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "track", "cueLanguage": "en" }), &d));
    let exe = engine("ffprobe").unwrap();
    let o = std::process::Command::new(exe).args(["-v", "error", "-select_streams", "s", "-show_entries", "stream=index", "-of", "csv=p=0"]).arg(&out).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&o.stdout).lines().count(), 1, "subtitle tracks");
});

pending!(tools, subtitles_from_cues_burned_in, {
    let d = CaseDir::new("subs-burn");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "burn" }), &d));
    media(&out, Some("h264"), None, Some(3.0), Some((320, 240)));
});

// ---------------------------------------------------------------- images and PDF

pending!(tools, crop_image_centre_half, {
    let d = CaseDir::new("crop-image");
    let spec = json!({ "x": 160, "y": 120, "w": 320, "h": 240 });
    let out = one(t("cropImage", &[jpg(d.path(), "photo.jpg", 640, 480)], json!({ "rotate": 0, "flipH": false, "flipV": false, "spec": spec, "out": null }), &d));
    image_ok(&out, "jpg", Some((320, 240)));
});

pending!(tools, crop_image_rotate_90_and_flip, {
    let d = CaseDir::new("crop-rotate");
    let spec = json!({ "x": 0, "y": 0, "w": 640, "h": 480 });
    let out = one(t("cropImage", &[png(d.path(), "sample.png", 640, 480)], json!({ "rotate": 90, "flipH": true, "flipV": false, "spec": spec, "out": null }), &d));
    image_ok(&out, "png", Some((480, 640)));
});

pending!(tools, create_pdf_two_images_a4, {
    let d = CaseDir::new("create-pdf");
    let out = one(t("createPdf", &[jpg(d.path(), "photo.jpg", 640, 480), png(d.path(), "sample.png", 640, 480)], json!({ "page": "a4", "orientation": "auto", "margin": 10 }), &d));
    assert_eq!(pdf_pages(&out), 2);
});

pending!(tools, merge_pdf_custom_order, {
    let d = CaseDir::new("merge-pdf");
    let a = pdf(d.path(), "a.pdf", 3);
    let b = pdf(d.path(), "b.pdf", 1);
    let out = one(t("mergePdf", &[a.clone(), b.clone()], json!({ "order": [b, a] }), &d));
    assert_eq!(name(&out), "Merged.pdf");
    assert_eq!(pdf_pages(&out), 4);
});

pending!(tools, split_pdf_ranges, {
    let d = CaseDir::new("split-ranges");
    let outs = t("splitPdf", &[pdf(d.path(), "doc.pdf", 3)], json!({ "groups": [[0], [1, 2]], "mode": "ranges" }), &d);
    assert_eq!(outs.len(), 2);
    assert_eq!((pdf_pages(&outs[0]), pdf_pages(&outs[1])), (1, 2));
});

pending!(tools, split_pdf_extract_page_2, {
    let d = CaseDir::new("split-extract");
    let out = one(t("splitPdf", &[pdf(d.path(), "doc.pdf", 3)], json!({ "groups": [[1]], "mode": "extract" }), &d));
    assert!(name(&out).ends_with(" p2.pdf"), "{}", name(&out));
    assert_eq!(pdf_pages(&out), 1);
});

pending!(tools, organize_pdf_reorder_and_rotate, {
    let d = CaseDir::new("organize");
    let src = pdf(d.path(), "doc.pdf", 3);
    let out = one(t("organizePdf", &[src.clone()], json!({ "pages": [{ "src": src, "index": 2, "rotate": 90 }, { "src": src, "index": 0 }] }), &d));
    assert_eq!(pdf_pages(&out), 2);
    assert!(String::from_utf8_lossy(&std::fs::read(&out).unwrap()).contains("/Rotate 90"));
});

pending!(tools, organize_pdf_no_valid_pages_is_an_error, {
    let d = CaseDir::new("organize-empty");
    let src = pdf(d.path(), "doc.pdf", 1);
    rejects(tool("organizePdf", &[src], &json!({ "pages": [] }), d.path()), "page");
});

pending!(tools, create_pdf_tiny_jpeg_embeds, {
    let d = CaseDir::new("tiny-jpeg");
    let small = jpg(d.path(), "tiny.jpg", 8, 8);
    assert!(size_of(&small) < 4096);
    assert_eq!(pdf_pages(&one(t("createPdf", &[small], json!({ "page": "a4", "orientation": "auto", "margin": 10 }), &d))), 1);
});

// ---------------------------------------------------------------- rename

pending!(tools, rename_swap_and_rename_then_undo, {
    let d = CaseDir::new("rename");
    let (a, b, c) = (d.join("a.txt"), d.join("b.txt"), d.join("c.txt"));
    for (p, s) in [(&a, "A"), (&b, "B"), (&c, "C")] {
        std::fs::write(p, s).unwrap();
    }
    let outs = t("rename", &[a.clone(), b.clone(), c.clone()], json!({ "pairs": [{ "from": a, "name": "b.txt" }, { "from": b, "name": "a.txt" }, { "from": c, "name": "c renamed.txt" }] }), &d);
    assert_eq!(outs.len(), 3);
    assert_eq!((std::fs::read_to_string(&a).unwrap(), std::fs::read_to_string(&b).unwrap()), ("B".into(), "A".into()));
    assert!(!c.exists() && std::fs::read_to_string(d.join("c renamed.txt")).unwrap() == "C");
    assert!(!d.files().iter().any(|f| name(f).starts_with(".orange-rename")), "temporary files left");
    orange_lib::tools::undo_last().unwrap();
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(&b).unwrap(), "B");
    assert_eq!(std::fs::read_to_string(&c).unwrap(), "C");
});

pending!(tools, rename_rejects_invalid_and_clashing_names, {
    let d = CaseDir::new("rename-bad");
    let (a, b) = (d.join("a.txt"), d.join("b.txt"));
    std::fs::write(&a, "A").unwrap();
    std::fs::write(&b, "B").unwrap();
    rejects(tool("rename", &[a.clone()], &json!({ "pairs": [{ "from": a, "name": "bad:name.txt" }] }), d.path()), "can't be used");
    rejects(tool("rename", &[a.clone()], &json!({ "pairs": [{ "from": a, "name": "b.txt" }] }), d.path()), "already exists");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(&b).unwrap(), "B");
});

// ---------------------------------------------------------------- protect / unlock

#[allow(dead_code)]
const PW: &str = "orange-Test 123";

pending!(tools, protect_pdf_aes256_then_unlock, {
    let d = CaseDir::new("protect-pdf");
    let locked = one(t("protect", &[pdf(d.path(), "doc.pdf", 3)], json!({ "mode": "pdf", "password": PW, "permissions": { "print": true, "copy": true, "edit": true } }), &d));
    let raw = String::from_utf8_lossy(&std::fs::read(&locked).unwrap()).into_owned();
    assert!(raw.contains("/Encrypt"), "not encrypted");
    assert!(raw.contains("/R 6"), "not AES-256");
    rejects(tool("unlock", &[locked.clone()], &json!({ "password": "wrong password" }), d.path()), "wrong");
    let open = one(t("unlock", &[locked], json!({ "password": PW }), &d));
    assert_eq!(pdf_pages(&open), 3);
    rejects(tool("unlock", &[open], &json!({ "password": PW }), d.path()), "isn't password-protected");
});

pending!(tools, protect_zip_aes256_then_unlock, {
    let d = CaseDir::new("protect-zip");
    let file = text_file(d.path(), "a.txt");
    let z = one(t("protect", &[file], json!({ "mode": "zip", "password": PW }), &d));
    assert_eq!(ext_lower(&z), "zip");
    let sz = engine("7z").unwrap();
    let test = |pw: Option<&str>| std::process::Command::new(&sz).args(["t", "-bd"]).arg(format!("-p{}", pw.unwrap_or(""))).arg(&z).output().unwrap().status.success();
    assert!(test(Some(PW)) && !test(Some("not the password")) && !test(None));
    rejects(tool("unlock", &[z.clone()], &json!({ "password": "nope" }), d.path()), "wrong");
    let dir = one(t("unlock", &[z], json!({ "password": PW }), &d));
    assert!(files_under(&dir).iter().any(|f| name(f) == "a.txt"));
});

pending!(tools, protect_7z_encrypted_names, {
    let d = CaseDir::new("protect-7z");
    let arc = one(t("protect", &[folder(d.path(), "Folder")], json!({ "mode": "7z", "password": PW }), &d));
    let out = std::process::Command::new(engine("7z").unwrap()).args(["l", "-p"]).arg(&arc).output().unwrap();
    assert!(!out.status.success(), "names are listable without the password");
});

pending!(tools, protect_pdf_non_ascii_password, {
    let d = CaseDir::new("protect-pdf-utf");
    let pw = "pässwörd ключ 密码";
    let locked = one(t("protect", &[pdf(d.path(), "doc.pdf", 1)], json!({ "mode": "pdf", "password": pw }), &d));
    assert_eq!(pdf_pages(&one(t("unlock", &[locked], json!({ "password": pw }), &d))), 1);
});

pending!(tools, protect_7z_non_ascii_password, {
    let d = CaseDir::new("protect-7z-utf");
    let pw = "pässwörd ключ 密码";
    let arc = one(t("protect", &[text_file(d.path(), "a.txt")], json!({ "mode": "7z", "password": pw }), &d));
    let dir = one(t("unlock", &[arc], json!({ "password": pw }), &d));
    assert!(files_under(&dir).iter().any(|f| name(f) == "a.txt"));
});

pending!(tools, protect_zip_two_items_with_same_name_fail_clearly, {
    let d = CaseDir::new("protect-clash");
    std::fs::create_dir_all(d.join("x")).unwrap();
    std::fs::create_dir_all(d.join("y")).unwrap();
    let a = text_file(&d.join("x"), "same.txt");
    let b = text_file(&d.join("y"), "same.txt");
    rejects(tool("protect", &[a, b], &json!({ "mode": "zip", "password": PW }), d.path()), "same name");
});

pending!(tools, protect_pdf_batch_already_protected_leaves_no_partial_results, {
    let d = CaseDir::new("protect-batch");
    let locked = one(t("protect", &[pdf(d.path(), "one.pdf", 1)], json!({ "mode": "pdf", "password": PW }), &d));
    let before = d.files().len();
    assert!(tool("protect", &[pdf(d.path(), "two.pdf", 1), locked], &json!({ "mode": "pdf", "password": PW }), d.path()).is_err());
    assert_eq!(d.files().len(), before + 1, "partial results left: {:?}", d.files());
});

// ---------------------------------------------------------------- metadata and OCR

pending!(tools, metadata_strip_jpg_exif, {
    let d = CaseDir::new("strip-jpg");
    let out = one(t("metadata", &[exif_rotated_jpg(d.path(), "r.jpg")], json!({ "mode": "strip" }), &d));
    assert!(!std::fs::read(&out).unwrap().windows(4).any(|w| w == b"Exif"));
});

pending!(tools, metadata_strip_pdf_info, {
    let d = CaseDir::new("strip-pdf");
    let out = one(t("metadata", &[pdf(d.path(), "doc.pdf", 1)], json!({ "mode": "strip" }), &d));
    assert!(!String::from_utf8_lossy(&std::fs::read(&out).unwrap()).contains("Orange Test"));
});

pending!(tools, metadata_strip_mp4_tags, {
    let d = CaseDir::new("strip-mp4");
    let src = media_fixture(d.path(), "mp4");
    let tagged = d.join("tagged.mp4");
    ffmpeg(&["-i", &src.to_string_lossy(), "-c", "copy", "-metadata", "title=Orange Secret", &tagged.to_string_lossy()]);
    let out = one(t("metadata", &[tagged], json!({ "mode": "strip" }), &d));
    assert!(!String::from_utf8_lossy(&std::fs::read(&out).unwrap()).contains("Orange Secret"));
});

pending!(tools, metadata_edit_mp3_title_and_pdf_title, {
    let d = CaseDir::new("meta-edit");
    let mp3 = one(t("metadata", &[media_fixture(d.path(), "mp3")], json!({ "mode": "edit", "fields": { "title": "New Title" } }), &d));
    let exe = engine("ffprobe").unwrap();
    let o = std::process::Command::new(exe).args(["-v", "error", "-show_entries", "format_tags=title", "-of", "csv=p=0"]).arg(&mp3).output().unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).contains("New Title"));
    let p = one(t("metadata", &[pdf(d.path(), "doc.pdf", 1)], json!({ "mode": "edit", "fields": { "title": "New PDF Title" } }), &d));
    assert!(String::from_utf8_lossy(&std::fs::read(&p).unwrap()).contains("New PDF Title"));
});

pending!(tools, metadata_same_named_files_from_different_folders_survive, {
    let d = CaseDir::new("meta-same");
    let a = jpg(&{ let p = d.join("x"); std::fs::create_dir_all(&p).unwrap(); p }, "photo.jpg", 32, 32);
    let b = jpg(&{ let p = d.join("y"); std::fs::create_dir_all(&p).unwrap(); p }, "photo.jpg", 32, 32);
    let outs = t("metadata", &[a, b], json!({ "mode": "strip" }), &d);
    assert_eq!(outs.len(), 2);
    assert!(outs.iter().all(|o| o.exists()) && outs[0] != outs[1]);
});

pending!(tools, crop_image_same_named_from_different_folders_survive, {
    let d = CaseDir::new("crop-same");
    let a = png(&{ let p = d.join("x"); std::fs::create_dir_all(&p).unwrap(); p }, "pic.png", 64, 64);
    let b = png(&{ let p = d.join("y"); std::fs::create_dir_all(&p).unwrap(); p }, "pic.png", 64, 64);
    let spec = json!({ "x": 0, "y": 0, "w": 32, "h": 32 });
    let outs = t("cropImage", &[a, b], json!({ "rotate": 0, "flipH": false, "flipV": false, "spec": spec, "out": d.join("out") }), &d);
    assert_eq!(outs.len(), 2);
    assert!(outs.iter().all(|o| o.exists()) && outs[0] != outs[1]);
});

pending!(tools, compress_audio_same_named_from_different_folders_survive, {
    let d = CaseDir::new("compress-same");
    let a = wav(&{ let p = d.join("x"); std::fs::create_dir_all(&p).unwrap(); p }, "tone.wav", 1.0, 44100, 1);
    let b = wav(&{ let p = d.join("y"); std::fs::create_dir_all(&p).unwrap(); p }, "tone.wav", 1.0, 44100, 1);
    let outs = t("compress", &[a, b], json!({ "audio": { "kbps": 128 }, "outDir": d.join("out") }), &d);
    assert_eq!(outs.len(), 2);
    assert!(outs[0] != outs[1]);
});

pending!(tools, ocr_image_to_txt, {
    let d = CaseDir::new("ocr-txt");
    let img = d.join("scan.png");
    // A clean, large rendering of the text mark (ImageMagick, as 1.x did).
    let magick = engine("imagemagick/magick").expect("magick");
    assert!(std::process::Command::new(magick).args(["-size", "1400x200", "xc:white", "-pointsize", "72", "-annotate", "+40+130", TEXT_MARK]).arg(&img).status().unwrap().success());
    let out = one(t("ocr", &[img], json!({ "output": "txt", "lang": "eng" }), &d));
    text_has(&out, &["Orange"]);
});

pending!(tools, ocr_image_to_searchable_pdf, {
    let d = CaseDir::new("ocr-pdf");
    let out = one(t("ocr", &[png(d.path(), "scan.png", 640, 480)], json!({ "output": "pdf", "lang": "eng" }), &d));
    assert_eq!(pdf_pages(&out), 1);
});

pending!(tools, ocr_scanned_pdf_to_md, {
    let d = CaseDir::new("ocr-md");
    let out = one(t("ocr", &[pdf(d.path(), "doc.pdf", 1)], json!({ "output": "md", "lang": "eng" }), &d));
    assert_eq!(ext_lower(&out), "md");
});

// ---------------------------------------------------------------- regressions (cases-tools.ts)

pending!(tools, normalize_audio_without_audio_fails_before_writing, {
    let d = CaseDir::new("normalize-noaudio");
    let silent = d.join("video only.mp4");
    let src = media_fixture(d.path(), "mp4");
    ffmpeg(&["-i", &src.to_string_lossy(), "-an", "-c", "copy", &silent.to_string_lossy()]);
    let before = d.files();
    assert!(tool("normalizeAudio", &[silent], &json!({ "I": -16, "TP": -1.5, "LRA": 11 }), d.path()).is_err());
    assert_eq!(d.files(), before);
});

pending!(tools, video_frames_time_past_end_is_skipped, {
    let d = CaseDir::new("frames-past-end");
    let outs = t("videoFrames", &[media_fixture(d.path(), "mp4")], json!({ "times": [1.0, 99.0] }), &d);
    let files: Vec<PathBuf> = outs.iter().flat_map(|o| if o.is_dir() { files_under(o) } else { vec![o.clone()] }).collect();
    assert_eq!(files.len(), 1, "{files:?}");
});

pending!(tools, join_audio_96k_flac_to_mp3_is_resampled, {
    let d = CaseDir::new("join-96k");
    let a = d.join("hi.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:sample_rate=96000", "-t", "1", &a.to_string_lossy()]);
    let b = media_fixture(d.path(), "mp3b");
    let out = one(t("joinAudio", &[a, b], json!({ "format": "mp3" }), &d));
    assert!(media(&out, None, Some("mp3"), Some(3.0), None).sample_rate <= 48000);
});

pending!(tools, trim_audio_silence_removal_on_pure_silence_fails_clearly, {
    let d = CaseDir::new("trim-silence");
    let e = tool("trimAudio", &[media_fixture(d.path(), "silence")], &json!({ "removeSilence": true }), d.path()).unwrap_err();
    assert!(e.to_lowercase().contains("silen"), "{e}");
});

pending!(tools, damaged_archive_gives_a_clear_error, {
    let d = CaseDir::new("damaged-zip");
    let z = zip(d.path(), "broken.zip");
    let b = std::fs::read(&z).unwrap();
    std::fs::write(&z, &b[..b.len() / 2]).unwrap();
    let e = tool("extractArchive", &[z], &json!({}), d.path()).unwrap_err();
    assert!(!e.trim().is_empty() && !e.contains("exit code"), "unclear error: {e}");
});
