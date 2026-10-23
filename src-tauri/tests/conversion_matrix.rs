//! The conversion matrix of 1.x (`conversionCases` in tests/cases.ts): every kind's
//! representative inputs to every target the wheel offers for them, checked by
//! `common::verify_conversion` (the port of `verifyConversion`).
//!
//! The in-process image targets that already ship are covered for real in `convert_image.rs`.
//! Everything here goes through the planned engine-backed `convert::convert` and waits on
//! the converters port. Office-only inputs (docx, pptx, xlsx, epub) are omitted: 1.x made them
//! with the app's own converter from Markdown/CSV, so they join once those targets pass.
#![allow(unexpected_cfgs)]

#[macro_use]
mod common;

macro_rules! matrix {
    ($($name:ident: $src:literal => $target:literal),* $(,)?) => {$(
        pending!(converters, $name, { common::check_conversion($src, $target) });
    )*};
}

matrix! {
    // image: png to everything but itself, jpg to png, and extra decoders
    image_png_to_jpg: "png" => "jpg",
    image_png_to_webp: "png" => "webp",
    image_png_to_heic: "png" => "heic",
    image_png_to_tiff: "png" => "tiff",
    image_png_to_avif: "png" => "avif",
    image_png_to_bmp: "png" => "bmp",
    image_png_to_pdf: "png" => "pdf",
    image_jpg_to_png: "jpg" => "png",
    image_webp_to_jpg: "webp" => "jpg",
    image_tiff_to_png: "tiff" => "png",
    image_bmp_to_png: "bmp" => "png",
    image_gif_to_png: "gif" => "png",
    // video
    video_mp4_to_mov: "mp4" => "mov",
    video_mp4_to_mkv: "mp4" => "mkv",
    video_mp4_to_webm: "mp4" => "webm",
    video_mp4_to_avi: "mp4" => "avi",
    video_mp4_to_wmv: "mp4" => "wmv",
    video_mp4_to_gif: "mp4" => "gif",
    video_mp4_to_mp3: "mp4" => "mp3",
    video_mov_to_mp4: "mov" => "mp4",
    // audio
    audio_wav_to_mp3: "wav" => "mp3",
    audio_wav_to_m4a: "wav" => "m4a",
    audio_wav_to_flac: "wav" => "flac",
    audio_wav_to_ogg: "wav" => "ogg",
    audio_wav_to_opus: "wav" => "opus",
    audio_wav_to_aiff: "wav" => "aiff",
    audio_wav_to_wma: "wav" => "wma",
    audio_mp3_to_wav: "mp3" => "wav",
    // pdf
    pdf_to_docx: "pdf" => "docx",
    pdf_to_pptx: "pdf" => "pptx",
    pdf_to_xlsx: "pdf" => "xlsx",
    pdf_to_jpg_all_pages: "pdf" => "jpg",
    pdf_to_png_all_pages: "pdf" => "png",
    pdf_to_epub: "pdf" => "epub",
    pdf_to_txt: "pdf" => "txt",
    pdf_to_md: "pdf" => "md",
    // documents
    document_md_to_docx: "md" => "docx",
    document_md_to_pdf: "md" => "pdf",
    document_md_to_txt: "md" => "txt",
    document_md_to_epub: "md" => "epub",
    document_md_to_html: "md" => "html",
    document_md_to_odt: "md" => "odt",
    document_md_to_rtf: "md" => "rtf",
    document_txt_to_docx: "txt" => "docx",
    document_html_to_md: "html" => "md",
    // spreadsheets
    spreadsheet_csv_to_xlsx: "csv" => "xlsx",
    spreadsheet_csv_to_ods: "csv" => "ods",
    spreadsheet_csv_to_tsv: "csv" => "tsv",
    spreadsheet_csv_to_pdf: "csv" => "pdf",
    // subtitles
    subtitle_srt_to_vtt: "srt" => "vtt",
    subtitle_srt_to_txt: "srt" => "txt",
    subtitle_vtt_to_srt: "vtt" => "srt",
    subtitle_vtt_to_txt: "vtt" => "txt",
    // archives and folders
    archive_zip_extract: "zip" => "extract",
    archive_zip_to_tar: "zip" => "tar",
    archive_zip_to_gz: "zip" => "gz",
    archive_zip_to_7z: "zip" => "7z",
    folder_to_zip: "folder" => "zip",
}
