//! SRT and WebVTT to each other and to plain text, in pure Rust (convert-subtitle.ts).
//! Tolerant of BOMs, CRLF/CR line endings, missing or wrong cue numbers, VTT headers/NOTE/STYLE/REGION
//! blocks, cue settings, comma or dot milliseconds, hour-less timestamps and inline tags.
//!
//! Public: `decode_text(bytes)` (UTF-8/UTF-16/Windows-1252), `parse_cues`, `to_srt`, `to_vtt`,
//! `to_txt`, and `convert`.

use super::{user, Ctx, R};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start: i64,
    pub end: i64,
    pub text: String,
}

/// Windows-1252's 0x80..0x9F block (the rest maps to the same code points as Latin-1).
const CP1252: [u16; 32] = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC,
    0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

pub fn cp1252(b: &[u8]) -> String {
    b.iter().map(|&c| if (0x80..0xA0).contains(&c) { char::from_u32(CP1252[(c - 0x80) as usize] as u32).unwrap_or('?') } else { c as char }).collect()
}

/// Bytes to text: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252.
pub fn decode_text(buf: &[u8]) -> String {
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    if buf.len() >= 2 && buf[0] == 0xFE && buf[1] == 0xFF {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    let body = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) { &buf[3..] } else { buf };
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => cp1252(body),
    }
}

/// "(h:)mm:ss(.mmm) --> (h:)mm:ss(.mmm)" at the start of a line, in ms.
fn timing(line: &str) -> Option<(i64, i64)> {
    let (a, b) = line.split_once("-->")?;
    let start = stamp_ms(a.trim())?;
    let rest = b.trim_start();
    let end_tok = rest.split_whitespace().next()?;
    Some((start, stamp_ms(end_tok)?))
}

fn stamp_ms(s: &str) -> Option<i64> {
    let num = |x: &str, max: usize| -> Option<i64> {
        if x.is_empty() || x.len() > max || !x.bytes().all(|c| c.is_ascii_digit()) {
            None
        } else {
            x.parse().ok()
        }
    };
    let frac_ms = |f: &str| -> Option<i64> {
        if f.is_empty() || f.len() > 3 || !f.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        format!("{f:0<3}").parse().ok()
    };
    let parts: Vec<&str> = s.split(':').collect();
    let last = *parts.last()?;
    // (h:)?mm:ss([.,:]fff)?
    let (h, m, sec, f) = match last.find(['.', ',']) {
        Some(i) => {
            let (sec, f) = (&last[..i], &last[i + 1..]);
            match parts.len() {
                2 => (0, num(parts[0], 2)?, num(sec, 2)?, frac_ms(f)?),
                3 => (num(parts[0], 9)?, num(parts[1], 2)?, num(sec, 2)?, frac_ms(f)?),
                _ => return None,
            }
        }
        None => match parts.len() {
            2 => (0, num(parts[0], 2)?, num(last, 2)?, 0),
            3 if last.len() <= 2 => (num(parts[0], 9)?, num(parts[1], 2)?, num(last, 2)?, 0),
            3 => (0, num(parts[0], 2)?, num(parts[1], 2)?, frac_ms(last)?),
            4 => (num(parts[0], 9)?, num(parts[1], 2)?, num(parts[2], 2)?, frac_ms(last)?),
            _ => return None,
        },
    };
    Some(((h * 60 + m) * 60 + sec) * 1000 + f)
}

fn is_index(l: &str) -> bool {
    let t = l.trim();
    !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit())
}

/// SRT or WebVTT (detected per cue, so mislabelled files still work).
pub fn parse_cues(text: &str) -> Vec<Cue> {
    let clean = text.trim_start_matches('\u{FEFF}').replace("\r\n", "\n").replace('\r', "\n");
    let vtt = clean.starts_with("WEBVTT");
    let lines: Vec<&str> = clean.split('\n').collect();
    let mut cues = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        let block = ["WEBVTT", "NOTE", "STYLE", "REGION"].iter().any(|k| t.starts_with(k) && t[k.len()..].chars().next().map(|c| !c.is_alphanumeric()).unwrap_or(true));
        if block {
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        let Some((start, end)) = timing(lines[i]) else {
            i += 1;
            continue;
        };
        i += 1;
        let mut body = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            if timing(lines[i]).is_some() {
                break;
            }
            if is_index(lines[i]) && i + 1 < lines.len() && timing(lines[i + 1]).is_some() {
                break;
            }
            body.push(lines[i]);
            i += 1;
        }
        let mut t = body.join("\n").trim_end().to_string();
        if vtt {
            t = decode_entities(&vtt_to_srt_text(&t));
        }
        cues.push(Cue { start, end: end.max(start), text: t });
    }
    cues.sort_by_key(|c| c.start);
    cues
}

fn stamp(ms: i64, sep: char) -> String {
    let t = ms.max(0);
    format!("{:02}:{:02}:{:02}{sep}{:03}", t / 3_600_000, (t % 3_600_000) / 60_000, (t % 60_000) / 1000, t % 1000)
}

/// Removes every `<...>` tag for which `drop(tag_body)` is true.
fn strip_tags(s: &str, drop: impl Fn(&str) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        match rest[i..].find('>') {
            Some(j) => {
                let tag = &rest[i + 1..i + j];
                if !drop(tag) {
                    out.push_str(&rest[i..i + j + 1]);
                }
                rest = &rest[i + j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('/').split(|c: char| c == '.' || c.is_whitespace()).next().unwrap_or("").to_ascii_lowercase()
}

/// Tags SRT players understand stay (<b> <i> <u> <font>); VTT-only ones are dropped.
fn vtt_to_srt_text(s: &str) -> String {
    strip_tags(s, |tag| {
        let n = tag_name(tag);
        matches!(n.as_str(), "c" | "v" | "lang" | "ruby" | "rt") || (n.contains(':') && n.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.'))
    })
}

fn decode_entities(s: &str) -> String {
    let mut out = s.replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", "\u{a0}").replace("&lrm;", "\u{200e}").replace("&rlm;", "\u{200f}");
    // &#NNN;
    while let Some(i) = out.find("&#") {
        let Some(j) = out[i..].find(';') else { break };
        let num = &out[i + 2..i + j];
        match num.parse::<u32>().ok().and_then(char::from_u32) {
            Some(c) => out.replace_range(i..i + j + 1, &c.to_string()),
            None => break,
        }
    }
    out.replace("&amp;", "&")
}

/// Removes ASS-style overrides like {\an8}.
fn strip_ass(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("{\\") {
        out.push_str(&rest[..i]);
        match rest[i..].find('}') {
            Some(j) => rest = &rest[i + j + 1..],
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn srt_to_vtt_text(s: &str) -> String {
    let s = strip_ass(s);
    let s = strip_tags(&s, |t| tag_name(t) == "font");
    // Bare ampersands become &amp; (entities stay).
    let mut amp = String::new();
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '&' {
            let rest: String = b[i + 1..].iter().take(12).collect();
            let ent = rest.find(';').map(|k| {
                let e = &rest[..k];
                !e.is_empty() && (e.chars().all(|c| c.is_ascii_alphabetic()) || (e.starts_with('#') && e[1..].chars().all(|c| c.is_ascii_digit()) && e.len() > 1))
            });
            amp.push_str(if ent == Some(true) { "&" } else { "&amp;" });
        } else {
            amp.push(b[i]);
        }
        i += 1;
    }
    // '<' that doesn't open <b>, <i>, <u> (or close them).
    let mut out = String::new();
    let mut rest = amp.as_str();
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let ok = ["b>", "i>", "u>", "/b>", "/i>", "/u>"].iter().any(|t| after.len() >= t.len() && after[..t.len()].eq_ignore_ascii_case(t));
        out.push_str(if ok { "<" } else { "&lt;" });
        rest = after;
    }
    out.push_str(rest);
    out.replace("-->", "--&gt;")
}

/// Dialogue only: no tags, no positioning codes, one cue per line.
pub fn plain_text(s: &str) -> String {
    let s = strip_ass(s);
    let s = strip_tags(&s, |t| matches!(tag_name(t).as_str(), "b" | "i" | "u" | "s" | "font"));
    s.replace('\u{a0}', " ").split('\n').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

pub fn to_srt(cues: &[Cue]) -> String {
    let body = cues.iter().enumerate().map(|(i, c)| format!("{}\n{} --> {}\n{}", i + 1, stamp(c.start, ','), stamp(c.end, ','), c.text)).collect::<Vec<_>>().join("\n\n") + "\n";
    // CRLF is what Windows players expect for SRT.
    body.replace('\n', "\r\n")
}

pub fn to_vtt(cues: &[Cue]) -> String {
    "WEBVTT\n\n".to_string() + &cues.iter().map(|c| format!("{} --> {}\n{}", stamp(c.start, '.'), stamp(c.end, '.'), srt_to_vtt_text(&c.text))).collect::<Vec<_>>().join("\n\n") + "\n"
}

pub fn to_txt(cues: &[Cue]) -> String {
    let mut out: Vec<String> = Vec::new();
    for c in cues {
        let line = plain_text(&c.text);
        // Drop roll-up duplicates.
        if !line.is_empty() && out.last() != Some(&line) {
            out.push(line);
        }
    }
    out.join("\r\n") + "\r\n"
}

pub fn convert(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let cues = parse_cues(&decode_text(&std::fs::read(input)?));
    if cues.is_empty() {
        return user("No subtitles found in this file.");
    }
    ctx.progress(0.5);
    let body = match target {
        "srt" => to_srt(&cues),
        "vtt" => to_vtt(&cues),
        "txt" => to_txt(&cues),
        _ => return user(format!("Can't convert subtitles to {}.", target.to_uppercase())),
    };
    let out = ctx.out(input, target, "");
    // UTF-8 with a BOM for SRT/TXT so older players and editors detect the encoding; VTT is UTF-8 by spec.
    let bytes = if target == "vtt" { body.into_bytes() } else { [&[0xEF, 0xBB, 0xBF][..], body.as_bytes()].concat() };
    std::fs::write(&out, bytes)?;
    ctx.progress(1.0);
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_vtt_round_trip() {
        let srt = "\u{FEFF}1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i> & you\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,250\r\n{\\an8}Top line\r\n";
        let cues = parse_cues(srt);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 1500);
        let vtt = to_vtt(&cues);
        assert!(vtt.starts_with("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\n<i>Hello</i> &amp; you"));
        assert!(vtt.contains("\nTop line"));
        let back = parse_cues(&vtt);
        assert_eq!(back[0].text, "<i>Hello</i> & you");
        assert_eq!(to_txt(&cues), "Hello & you\r\nTop line\r\n");
    }

    #[test]
    fn vtt_quirks() {
        let vtt = "WEBVTT - title\n\nNOTE a comment\nmore\n\n01:02.5 --> 01:04.000 align:start\n<v Bob>Hi &lt;there&gt;</v>\n\n00:01:05.000 --> 00:01:06.000\nnext\n";
        let c = parse_cues(vtt);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].start, 62_500);
        assert_eq!(c[0].text, "Hi <there>");
        assert!(to_srt(&c).starts_with("1\r\n00:01:02,500 --> 00:01:04,000\r\nHi <there>"));
    }

    #[test]
    fn decodes_legacy_text() {
        assert_eq!(decode_text(&[0x93, b'h', b'i', 0x94]), "\u{201C}hi\u{201D}");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'a', 0]), "a");
    }
}
