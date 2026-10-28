//! What Orange can convert, by file kind: the Rust twin of src/shared/catalog.ts
//! (`kindOfExt`, `conversionTargets`). jobs.rs checks a wheel choice against the real files here.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    Image,
    Video,
    Audio,
    Pdf,
    Document,
    Slides,
    Spreadsheet,
    Ebook,
    Subtitle,
    Archive,
    Folder,
    Other,
}

pub fn kind_of_ext(ext: &str) -> Kind {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "jfif" | "png" | "webp" | "heic" | "heif" | "tif" | "tiff" | "avif" | "bmp" | "gif" | "svg" | "ico" | "jxl" => Kind::Image,
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "ts" | "mts" | "3gp" => Kind::Video,
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "aif" | "aiff" | "wma" | "alac" | "amr" => Kind::Audio,
        "pdf" => Kind::Pdf,
        "docx" | "doc" | "odt" | "pages" | "md" | "markdown" | "txt" | "rtf" | "html" | "htm" => Kind::Document,
        "epub" => Kind::Ebook,
        "pptx" | "ppt" | "odp" | "key" => Kind::Slides,
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "csv" | "tsv" | "numbers" => Kind::Spreadsheet,
        "srt" | "vtt" => Kind::Subtitle,
        "zip" | "tar" | "gz" | "tgz" | "rar" | "7z" => Kind::Archive,
        _ => Kind::Other,
    }
}

const IMAGE_OUT: &[&str] = &["jpg", "png", "webp", "heic", "tiff", "avif", "bmp", "pdf"];
const AUDIO_OUT: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff", "wma"];
const VIDEO_OUT: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "wmv", "gif", "mp3"];
const PDF_OUT: &[&str] = &["docx", "pptx", "xlsx", "jpg", "png", "epub", "txt", "md"];
const DOC_OUT: &[&str] = &["docx", "pdf", "md", "txt", "epub", "html", "odt", "rtf"];
const SLIDES_OUT: &[&str] = &["pdf", "jpg", "png", "pptx"];
const SHEET_OUT: &[&str] = &["xlsx", "ods", "csv", "tsv", "pdf"];
const EBOOK_OUT: &[&str] = &["pdf", "docx", "md", "txt", "html"];
const SUB_OUT: &[&str] = &["srt", "vtt", "txt"];
const ARCHIVE_OUT: &[&str] = &["extract", "zip", "tar", "gz", "7z"];
const ANY_OUT: &[&str] = &["zip"];

fn normalize(ext: &str) -> &str {
    match ext {
        "jpeg" | "jfif" => "jpg",
        "tif" => "tiff",
        "heif" => "heic",
        "aif" => "aiff",
        "markdown" => "md",
        "htm" => "html",
        "oga" => "ogg",
        "tgz" => "gz",
        e => e,
    }
}

/// Targets ("png", "extract") offered for these extensions; folders only zip.
pub fn valid_targets(exts: &[String], has_folder: bool) -> Vec<&'static str> {
    if has_folder {
        return vec!["zip"];
    }
    if exts.is_empty() {
        return vec![];
    }
    let kinds: std::collections::HashSet<Kind> = exts.iter().map(|e| kind_of_ext(e)).collect();
    if kinds.len() != 1 {
        // Mixed selection: only zipping makes sense.
        return vec!["zip"];
    }
    let kind = *kinds.iter().next().unwrap();
    let list = match kind {
        Kind::Image => IMAGE_OUT,
        Kind::Audio => AUDIO_OUT,
        Kind::Video => VIDEO_OUT,
        Kind::Pdf => PDF_OUT,
        Kind::Document => DOC_OUT,
        Kind::Slides => SLIDES_OUT,
        Kind::Spreadsheet => SHEET_OUT,
        Kind::Ebook => EBOOK_OUT,
        Kind::Subtitle => SUB_OUT,
        Kind::Archive => ARCHIVE_OUT,
        Kind::Folder | Kind::Other => ANY_OUT,
    };
    let same: std::collections::HashSet<String> = exts.iter().map(|e| normalize(&e.to_ascii_lowercase()).to_string()).collect();
    // Hide "convert to the same format" unless it is the only thing on offer.
    let filtered: Vec<&'static str> = list.iter().copied().filter(|x| !(same.len() == 1 && same.contains(*x) && kind != Kind::Archive)).collect();
    if filtered.is_empty() {
        list.to_vec()
    } else {
        filtered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_match_the_catalog() {
        let v = |e: &[&str]| valid_targets(&e.iter().map(|s| s.to_string()).collect::<Vec<_>>(), false);
        assert_eq!(v(&["jpeg"]), vec!["png", "webp", "heic", "tiff", "avif", "bmp", "pdf"]);
        assert_eq!(v(&["heif"]), vec!["jpg", "png", "webp", "tiff", "avif", "bmp", "pdf"]);
        assert!(v(&["mp4"]).contains(&"mp3"));
        assert_eq!(v(&["zip"])[0], "extract");
        assert_eq!(v(&["png", "mp3"]), vec!["zip"]);
        assert_eq!(v(&["exe"]), vec!["zip"]);
    }
}
