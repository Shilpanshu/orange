//! A minimal PDF reader for the tests: enough to count pages and read their `/Rotate` in order,
//! including files whose page tree sits inside compressed object streams (pdf-lib's default).
//! Not a PDF library: no encryption, no incremental updates, no xref (objects are found by scanning).
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Read;

pub struct PdfDoc {
    /// Object number -> its dictionary / value text, whitespace collapsed.
    objs: HashMap<u32, String>,
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find(h: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    h.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

impl PdfDoc {
    pub fn parse(b: &[u8]) -> PdfDoc {
        let mut objs = HashMap::new();
        let mut at = 0;
        while let Some(i) = find(b, b" obj", at) {
            at = i + 4;
            // "<num> <gen> obj": digits, space, digits before the keyword.
            let head = &b[i.saturating_sub(24)..i];
            let head = String::from_utf8_lossy(head);
            let mut it = head.rsplit(|c: char| c.is_whitespace()).filter(|s| !s.is_empty());
            let (Some(gen), Some(num)) = (it.next(), it.next()) else { continue };
            let (Ok(_), Ok(num)) = (gen.parse::<u32>(), num.rsplit(|c: char| !c.is_ascii_digit()).next().unwrap_or("").parse::<u32>()) else { continue };
            let Some(end) = find(b, b"endobj", at) else { break };
            let body = &b[at..end];
            at = end + 6;
            // A stream object: the dictionary is everything before `stream`.
            if let Some(s) = find(body, b"stream", 0) {
                let dict = collapse(&String::from_utf8_lossy(&body[..s]));
                let mut data = &body[s + 6..];
                if data.starts_with(b"\r\n") {
                    data = &data[2..];
                } else if data.starts_with(b"\n") {
                    data = &data[1..];
                }
                if let Some(e) = find(data, b"endstream", 0) {
                    data = &data[..e];
                }
                if dict.contains("/ObjStm") {
                    let mut raw = Vec::new();
                    if flate2::read::ZlibDecoder::new(data).read_to_end(&mut raw).is_ok() {
                        let n: usize = key_int(&dict, "/N").unwrap_or(0) as usize;
                        let first: usize = key_int(&dict, "/First").unwrap_or(0) as usize;
                        let head = String::from_utf8_lossy(&raw[..first.min(raw.len())]).into_owned();
                        let nums: Vec<usize> = head.split_whitespace().filter_map(|t| t.parse().ok()).collect();
                        for k in 0..n.min(nums.len() / 2) {
                            let (on, off) = (nums[2 * k] as u32, nums[2 * k + 1]);
                            let end = if k + 1 < n && 2 * k + 3 < nums.len() { nums[2 * k + 3] } else { raw.len().saturating_sub(first) };
                            let (s0, e0) = (first + off, (first + end).min(raw.len()));
                            if s0 <= e0 {
                                objs.insert(on, collapse(&String::from_utf8_lossy(&raw[s0..e0])));
                            }
                        }
                    }
                }
                objs.entry(num).or_insert(dict);
            } else {
                objs.insert(num, collapse(&String::from_utf8_lossy(body)));
            }
        }
        PdfDoc { objs }
    }

    /// The leaf pages in document order: (object number, rotation, inherited from the tree).
    pub fn pages(&self) -> Vec<(u32, i64)> {
        let root = self
            .objs
            .values()
            .find(|t| t.contains("/Type /Catalog"))
            .and_then(|t| key_ref(t, "/Pages"));
        let mut out = vec![];
        if let Some(r) = root {
            self.walk(r, 0, &mut out, 0);
        }
        out
    }

    fn walk(&self, n: u32, inherited: i64, out: &mut Vec<(u32, i64)>, depth: usize) {
        let Some(t) = self.objs.get(&n) else { return };
        if depth > 40 {
            return;
        }
        let rot = key_int(t, "/Rotate").unwrap_or(inherited);
        match key_array_refs(t, "/Kids") {
            Some(kids) => kids.into_iter().for_each(|k| self.walk(k, rot, out, depth + 1)),
            None => out.push((n, rot)),
        }
    }
}

/// `/Key 12` -> 12.
fn key_int(t: &str, key: &str) -> Option<i64> {
    let i = t.find(key)?;
    let rest = t[i + key.len()..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '-')).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// `/Key 12 0 R` -> 12.
fn key_ref(t: &str, key: &str) -> Option<u32> {
    let i = t.find(key)?;
    t[i + key.len()..].trim_start().split(' ').next()?.parse().ok()
}

/// `/Key [ 3 0 R 4 0 R ]` -> [3, 4].
fn key_array_refs(t: &str, key: &str) -> Option<Vec<u32>> {
    let i = t.find(key)?;
    let rest = t[i + key.len()..].trim_start();
    let rest = rest.strip_prefix('[')?;
    let inner = &rest[..rest.find(']')?];
    let toks: Vec<&str> = inner.split_whitespace().collect();
    Some(toks.chunks(3).filter(|c| c.len() == 3 && c[2] == "R").filter_map(|c| c[0].parse().ok()).collect())
}
