//! Spreadsheets without an office suite (the exceljs/JSZip parts of convert-docs.ts): CSV/TSV
//! reading (delimiter sniffing, RFC 4180) and writing, a values-and-formats XLSX reader and
//! writer, a plain ODS writer, and sheets as printable HTML tables.

use super::super::subtitle::decode_text;
use super::super::{Fail, R};
use super::pdf::escape_html;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Empty,
    Num(f64, Option<String>),
    Bool(bool),
    Str(String),
}

// ------------------------------------------------------------------ CSV

pub fn sniff_delimiter(text: &str) -> char {
    let sample: Vec<&str> = text[..text.len().min(64_000)].lines().take(30).filter(|l| !l.trim().is_empty()).collect();
    let mut best = ',';
    let mut best_score = -1i64;
    for d in [',', ';', '\t', '|'] {
        let counts: Vec<i64> = sample
            .iter()
            .map(|l| {
                let (mut n, mut q) = (0, false);
                for ch in l.chars() {
                    if ch == '"' {
                        q = !q;
                    } else if ch == d && !q {
                        n += 1;
                    }
                }
                n
            })
            .collect();
        let nz: Vec<i64> = counts.iter().copied().filter(|&c| c > 0).collect();
        if nz.is_empty() {
            continue;
        }
        let mode = *nz.iter().max_by_key(|&&x| (nz.iter().filter(|&&y| y == x).count(), -x)).unwrap();
        let consistent = counts.iter().filter(|&&c| c == mode).count() as i64;
        let score = consistent * 100 + mode;
        if score > best_score {
            best_score = score;
            best = d;
        }
    }
    best
}

pub fn parse_delimited(text: &str, d: char) -> Vec<Vec<String>> {
    let mut rows = vec![];
    let mut row = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut it = text.chars().peekable();
    while let Some(ch) = it.next() {
        if quoted {
            if ch == '"' {
                if it.peek() == Some(&'"') {
                    field.push('"');
                    it.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == d {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && it.peek() == Some(&'\n') {
                it.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

pub fn write_delimited(rows: &[Vec<String>], d: char) -> String {
    let q = |s: &String| {
        if s.contains(d) || s.contains(['"', '\r', '\n']) || s.starts_with(char::is_whitespace) || s.ends_with(char::is_whitespace) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.clone()
        }
    };
    let d = d.to_string();
    "\u{FEFF}".to_string() + &rows.iter().map(|r| r.iter().map(q).collect::<Vec<_>>().join(&d)).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

pub fn read_delimited_file(input: &Path) -> R<Vec<Vec<String>>> {
    let text = decode_text(&std::fs::read(input)?);
    let tsv = input.extension().map(|e| e.eq_ignore_ascii_case("tsv")).unwrap_or(false);
    let d = if tsv { '\t' } else { sniff_delimiter(&text) };
    Ok(parse_delimited(&text, d))
}

/// CSV text → typed value: plain numbers become numbers, IDs with leading zeros stay text.
pub fn typed_value(s: &str) -> Val {
    if s.is_empty() {
        return Val::Empty;
    }
    let body = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mant, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int, frac) = match mant.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (mant, None),
    };
    let int_ok = int == "0" || (!int.is_empty() && int.len() <= 15 && !int.starts_with('0') && int.bytes().all(|c| c.is_ascii_digit()));
    let frac_ok = frac.map(|f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit())).unwrap_or(true);
    let exp_ok = exp.map(|e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && e.bytes().all(|c| c.is_ascii_digit())
    }).unwrap_or(true);
    if int_ok && frac_ok && exp_ok {
        if let Ok(v) = s.parse::<f64>() {
            if v.is_finite() {
                return Val::Num(v, None);
            }
        }
    }
    if s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false") {
        return Val::Bool(s.eq_ignore_ascii_case("true"));
    }
    Val::Str(s.to_string())
}

pub fn safe_sheet_name(s: &str, used: &mut Vec<String>) -> String {
    let cleaned: String = s.chars().map(|c| if "[]:*?/\\".contains(c) { ' ' } else { c }).collect();
    let base: String = { let t = cleaned.trim(); if t.is_empty() { "Sheet".to_string() } else { t.chars().take(31).collect() } };
    let mut name = base.clone();
    let mut i = 2;
    while used.contains(&name.to_lowercase()) {
        let suffix = format!(" {i}");
        name = format!("{}{suffix}", base.chars().take(31 - suffix.len()).collect::<String>());
        i += 1;
    }
    used.push(name.to_lowercase());
    name
}

// ------------------------------------------------------------------ tiny XML scanning

struct Tag<'a> {
    name: &'a str,
    attrs: &'a str,
    end: bool,
    empty: bool,
    /// Text between this tag and the next one.
    text: &'a str,
}

fn tags(xml: &str) -> Vec<Tag<'_>> {
    let mut out = vec![];
    let mut i = 0;
    let b = xml.as_bytes();
    while let Some(off) = xml[i..].find('<') {
        let s = i + off;
        if xml[s..].starts_with("<?") || xml[s..].starts_with("<!") {
            i = s + xml[s..].find('>').map(|j| j + 1).unwrap_or(xml.len() - s);
            continue;
        }
        let Some(e) = xml[s..].find('>') else { break };
        let inner = &xml[s + 1..s + e];
        let end = inner.starts_with('/');
        let empty = inner.ends_with('/');
        let inner = inner.trim_start_matches('/').trim_end_matches('/');
        let (name, attrs) = match inner.find(|c: char| c.is_whitespace()) {
            Some(k) => (&inner[..k], &inner[k..]),
            None => (inner, ""),
        };
        let next = xml[s + e + 1..].find('<').map(|k| s + e + 1 + k).unwrap_or(b.len());
        out.push(Tag { name: name.rsplit(':').next().unwrap_or(name), attrs, end, empty, text: &xml[s + e + 1..next] });
        i = s + e + 1;
    }
    out
}

fn attr(attrs: &str, name: &str) -> Option<String> {
    for q in ['"', '\''] {
        let key = format!(" {name}={q}");
        let padded = format!(" {attrs}");
        if let Some(i) = padded.find(&key) {
            let rest = &padded[i + key.len()..];
            return rest.find(q).map(|j| unxml(&rest[..j]));
        }
    }
    None
}

fn unxml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find(';') else {
            out.push_str(&rest[i..]);
            return out;
        };
        let e = &rest[i + 1..i + j];
        let c = match e {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            x if x.starts_with("#x") => u32::from_str_radix(&x[2..], 16).ok().and_then(char::from_u32),
            x if x.starts_with('#') => x[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => out.push(c),
            None => out.push_str(&rest[i..i + j + 1]),
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out
}

fn xml_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => o.push(c),
        }
    }
    o
}

// ------------------------------------------------------------------ XLSX reading

fn zip_text(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn col_index(r: &str) -> usize {
    let mut n = 0usize;
    for c in r.chars().take_while(|c| c.is_ascii_alphabetic()) {
        n = n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.saturating_sub(1)
}

fn row_index(r: &str) -> usize {
    r.trim_start_matches(|c: char| c.is_ascii_alphabetic()).parse::<usize>().unwrap_or(1).saturating_sub(1)
}

fn is_date_format(id: u32, code: Option<&str>) -> bool {
    if (14..=22).contains(&id) || (45..=47).contains(&id) {
        return true;
    }
    let Some(code) = code else { return false };
    let mut plain = String::new();
    let (mut in_q, mut in_b) = (false, false);
    for c in code.chars() {
        match c {
            '"' => in_q = !in_q,
            '[' if !in_q => in_b = true,
            ']' if !in_q => in_b = false,
            c if !in_q && !in_b => plain.push(c.to_ascii_lowercase()),
            _ => {}
        }
    }
    plain.contains('y') || plain.contains('d') || (plain.contains('h') && plain.contains('m')) || plain.contains("mmm")
}

/// Excel serial → "2024-05-01" or "2024-05-01 13:45:00".
fn format_serial(v: f64) -> String {
    let secs = ((v - 25569.0) * 86400.0).round() as i64;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    if tod == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", tod / 3600, tod % 3600 / 60, tod % 60)
    }
}

fn num_text(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    // toPrecision(15), trimmed.
    let s = format!("{:.*e}", 14, v);
    let back: f64 = s.parse().unwrap_or(v);
    let t = format!("{back}");
    t
}

/// Every visible worksheet as rows of display strings, trailing blanks trimmed.
pub fn read_xlsx(file: &Path) -> R<Vec<Sheet>> {
    let bad = || Fail::User("This workbook can't be read. It may be password-protected or damaged.".into());
    let f = std::fs::File::open(file)?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| bad())?;
    let wb = zip_text(&mut z, "xl/workbook.xml").ok_or_else(bad)?;
    let rels = zip_text(&mut z, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let mut targets = HashMap::new();
    for t in tags(&rels) {
        if t.name == "Relationship" {
            if let (Some(id), Some(tg)) = (attr(t.attrs, "Id"), attr(t.attrs, "Target")) {
                let path = if let Some(abs) = tg.strip_prefix('/') { abs.to_string() } else { format!("xl/{tg}") };
                targets.insert(id, path);
            }
        }
    }
    let mut shared: Vec<String> = vec![];
    if let Some(ss) = zip_text(&mut z, "xl/sharedStrings.xml") {
        let mut cur: Option<String> = None;
        let mut in_rph = false;
        for t in tags(&ss) {
            match (t.name, t.end) {
                ("si", false) if !t.empty => cur = Some(String::new()),
                ("si", false) => shared.push(String::new()),
                ("si", true) => shared.push(cur.take().unwrap_or_default()),
                ("rPh", false) => in_rph = !t.empty,
                ("rPh", true) => in_rph = false,
                ("t", false) if !t.empty && !in_rph => {
                    if let Some(c) = cur.as_mut() {
                        c.push_str(&unxml(t.text));
                    }
                }
                _ => {}
            }
        }
    }
    // Styles: which cell formats are dates.
    let mut date_xf: Vec<bool> = vec![];
    if let Some(st) = zip_text(&mut z, "xl/styles.xml") {
        let mut codes = HashMap::new();
        let mut in_xfs = false;
        for t in tags(&st) {
            match t.name {
                "numFmt" if !t.end => {
                    if let (Some(id), Some(c)) = (attr(t.attrs, "numFmtId"), attr(t.attrs, "formatCode")) {
                        codes.insert(id.parse::<u32>().unwrap_or(0), c);
                    }
                }
                "cellXfs" => in_xfs = !t.end && !t.empty,
                "xf" if in_xfs && !t.end => {
                    let id = attr(t.attrs, "numFmtId").and_then(|x| x.parse().ok()).unwrap_or(0);
                    date_xf.push(is_date_format(id, codes.get(&id).map(String::as_str)));
                }
                _ => {}
            }
        }
    }
    let mut sheets = vec![];
    let mut all = vec![];
    for t in tags(&wb) {
        if t.name == "sheet" && !t.end {
            let name = attr(t.attrs, "name").unwrap_or_else(|| "Sheet".into());
            let state = attr(t.attrs, "state").unwrap_or_default();
            let rid = attr(t.attrs, "r:id").or_else(|| attr(t.attrs, "id")).unwrap_or_default();
            all.push((name, state, targets.get(&rid).cloned().unwrap_or_default()));
        }
    }
    let visible: Vec<_> = all.iter().filter(|s| s.1.is_empty() || s.1 == "visible").cloned().collect();
    for (name, _, path) in if visible.is_empty() { all } else { visible } {
        let Some(xml) = zip_text(&mut z, &path) else { continue };
        let mut grid: Vec<Vec<String>> = vec![];
        let mut merged_slaves: Vec<(usize, usize)> = vec![];
        let (mut r, mut c, mut ty, mut style) = (0usize, 0usize, String::new(), 0usize);
        let mut val: Option<String> = None;
        let mut inline = String::new();
        let mut next_col = 0usize;
        let mut cur_row = 0usize;
        for t in tags(&xml) {
            match (t.name, t.end) {
                ("row", false) => {
                    cur_row = attr(t.attrs, "r").and_then(|x| x.parse::<usize>().ok()).map(|x| x - 1).unwrap_or(cur_row);
                    next_col = 0;
                    if t.empty {
                        cur_row += 1;
                    }
                }
                ("row", true) => cur_row += 1,
                ("c", false) => {
                    let rf = attr(t.attrs, "r");
                    r = rf.as_deref().map(row_index).unwrap_or(cur_row);
                    c = rf.as_deref().map(col_index).unwrap_or(next_col);
                    next_col = c + 1;
                    ty = attr(t.attrs, "t").unwrap_or_default();
                    style = attr(t.attrs, "s").and_then(|x| x.parse().ok()).unwrap_or(0);
                    val = None;
                    inline.clear();
                    if t.empty {
                        continue;
                    }
                }
                ("v", false) if !t.empty => val = Some(unxml(t.text)),
                ("t", false) if !t.empty && ty == "inlineStr" => inline.push_str(&unxml(t.text)),
                ("c", true) => {
                    let text = match ty.as_str() {
                        "s" => val.as_ref().and_then(|v| v.parse::<usize>().ok()).and_then(|i| shared.get(i).cloned()).unwrap_or_default(),
                        "inlineStr" => inline.clone(),
                        "b" => if val.as_deref() == Some("1") { "TRUE".into() } else { "FALSE".into() },
                        "str" | "e" => val.clone().unwrap_or_default(),
                        _ => match val.as_ref().and_then(|v| v.parse::<f64>().ok()) {
                            Some(v) if date_xf.get(style).copied().unwrap_or(false) => format_serial(v),
                            Some(v) => num_text(v),
                            None => val.clone().unwrap_or_default(),
                        },
                    };
                    if grid.len() <= r {
                        grid.resize(r + 1, vec![]);
                    }
                    if grid[r].len() <= c {
                        grid[r].resize(c + 1, String::new());
                    }
                    grid[r][c] = text;
                }
                ("mergeCell", false) => {
                    if let Some(rf) = attr(t.attrs, "ref") {
                        if let Some((a, b)) = rf.split_once(':') {
                            for rr in row_index(a)..=row_index(b) {
                                for cc in col_index(a)..=col_index(b) {
                                    if (rr, cc) != (row_index(a), col_index(a)) {
                                        merged_slaves.push((rr, cc));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        for (rr, cc) in merged_slaves {
            if let Some(cell) = grid.get_mut(rr).and_then(|row| row.get_mut(cc)) {
                cell.clear();
            }
        }
        for row in grid.iter_mut() {
            while row.last().map(|s| s.is_empty()).unwrap_or(false) {
                row.pop();
            }
        }
        while grid.last().map(|r| r.is_empty()).unwrap_or(false) {
            grid.pop();
        }
        let width = grid.iter().map(|r| r.len()).max().unwrap_or(0);
        for row in grid.iter_mut() {
            row.resize(width, String::new());
        }
        sheets.push(Sheet { name, rows: grid });
    }
    Ok(sheets)
}

// ------------------------------------------------------------------ XLSX writing

fn col_name(mut i: usize) -> String {
    let mut s = String::new();
    i += 1;
    while i > 0 {
        let m = (i - 1) % 26;
        s.insert(0, (b'A' + m as u8) as char);
        i = (i - 1) / 26;
    }
    s
}

fn zip_files(out: &Path, files: &[(&str, Vec<u8>)], stored_first: bool) -> R<()> {
    let f = std::fs::File::create(out)?;
    let mut z = zip::ZipWriter::new(f);
    for (i, (name, data)) in files.iter().enumerate() {
        let method = if stored_first && i == 0 { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated };
        let opts = zip::write::SimpleFileOptions::default().compression_method(method);
        z.start_file(*name, opts).map_err(|e| Fail::Raw(e.to_string()))?;
        z.write_all(data)?;
    }
    z.finish().map_err(|e| Fail::Raw(e.to_string()))?;
    Ok(())
}

pub fn zip_write(out: &Path, files: &[(&str, Vec<u8>)]) -> R<()> {
    zip_files(out, files, false)
}

/// A values-only workbook (number formats and column widths kept).
pub fn write_xlsx(sheets: &[(String, Vec<Vec<Val>>, Vec<f64>)], out: &Path) -> R<()> {
    let mut fmts: Vec<String> = vec![];
    for (_, rows, _) in sheets {
        for r in rows {
            for v in r {
                if let Val::Num(_, Some(f)) = v {
                    if !fmts.contains(f) {
                        fmts.push(f.clone());
                    }
                }
            }
        }
    }
    let mut files: Vec<(String, Vec<u8>)> = vec![];
    let mut used = vec![];
    let mut wb_sheets = String::new();
    let mut wb_rels = String::new();
    let mut ct = String::new();
    for (i, (name, rows, widths)) in sheets.iter().enumerate() {
        let n = i + 1;
        let name = safe_sheet_name(name, &mut used);
        wb_sheets.push_str(&format!("<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>", xml_esc(&name)));
        wb_rels.push_str(&format!("<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"));
        ct.push_str(&format!("<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"));
        let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
        if !widths.is_empty() {
            x.push_str("<cols>");
            for (c, w) in widths.iter().enumerate() {
                x.push_str(&format!("<col min=\"{0}\" max=\"{0}\" width=\"{w}\" customWidth=\"1\"/>", c + 1));
            }
            x.push_str("</cols>");
        }
        x.push_str("<sheetData>");
        for (ri, r) in rows.iter().enumerate() {
            x.push_str(&format!("<row r=\"{}\">", ri + 1));
            for (ci, v) in r.iter().enumerate() {
                let rf = format!("{}{}", col_name(ci), ri + 1);
                match v {
                    Val::Empty => {}
                    Val::Num(n, f) => {
                        let s = f.as_ref().and_then(|f| fmts.iter().position(|x| x == f)).map(|i| format!(" s=\"{}\"", i + 1)).unwrap_or_default();
                        x.push_str(&format!("<c r=\"{rf}\"{s}><v>{n}</v></c>"));
                    }
                    Val::Bool(b) => x.push_str(&format!("<c r=\"{rf}\" t=\"b\"><v>{}</v></c>", *b as u8)),
                    Val::Str(s) => x.push_str(&format!("<c r=\"{rf}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>", xml_esc(s))),
                }
            }
            x.push_str("</row>");
        }
        x.push_str("</sheetData></worksheet>");
        files.push((format!("xl/worksheets/sheet{n}.xml"), x.into_bytes()));
    }
    let numfmts = if fmts.is_empty() { String::new() } else {
        format!("<numFmts count=\"{}\">{}</numFmts>", fmts.len(), fmts.iter().enumerate().map(|(i, f)| format!("<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>", 164 + i, xml_esc(f))).collect::<String>())
    };
    let xfs = std::iter::once("<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>".to_string())
        .chain((0..fmts.len()).map(|i| format!("<xf numFmtId=\"{}\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>", 164 + i)))
        .collect::<String>();
    let styles = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">{numfmts}<fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"{}\">{xfs}</cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>", fmts.len() + 1);
    let n = sheets.len();
    let head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
    let mut all: Vec<(String, Vec<u8>)> = vec![
        ("[Content_Types].xml".into(), format!("{head}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>{ct}</Types>").into_bytes()),
        ("_rels/.rels".into(), format!("{head}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>").into_bytes()),
        ("docProps/core.xml".into(), format!("{head}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:creator>Orange</dc:creator></cp:coreProperties>").into_bytes()),
        ("xl/workbook.xml".into(), format!("{head}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>{wb_sheets}</sheets></workbook>").into_bytes()),
        ("xl/_rels/workbook.xml.rels".into(), format!("{head}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{wb_rels}<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>", n + 1).into_bytes()),
        ("xl/styles.xml".into(), styles.into_bytes()),
    ];
    all.extend(files);
    let refs: Vec<(&str, Vec<u8>)> = all.iter().map(|(a, b)| (a.as_str(), b.clone())).collect();
    zip_files(out, &refs, false)
}

/// Delimited rows → a typed workbook with column widths (rowsToWorkbook).
pub fn rows_to_xlsx(sheets: &[Sheet], out: &Path) -> R<()> {
    let data: Vec<(String, Vec<Vec<Val>>, Vec<f64>)> = sheets
        .iter()
        .map(|s| {
            let mut widths: Vec<f64> = vec![];
            for r in &s.rows {
                for (i, v) in r.iter().enumerate() {
                    if widths.len() <= i {
                        widths.resize(i + 1, 8.0);
                    }
                    widths[i] = widths[i].max(((v.chars().count() + 2) as f64).min(50.0));
                }
            }
            (s.name.clone(), s.rows.iter().map(|r| r.iter().map(|v| typed_value(v)).collect()).collect(), widths)
        })
        .collect();
    write_xlsx(&data, out)
}

// ------------------------------------------------------------------ ODS

/// A plain OpenDocument spreadsheet (values only) for when no office suite is around.
pub fn write_ods(sheets: &[Sheet], out: &Path) -> R<()> {
    let mut used = vec![];
    let tables: String = sheets
        .iter()
        .map(|s| {
            let width = s.rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
            let rows: String = s
                .rows
                .iter()
                .map(|r| {
                    let cells: String = r
                        .iter()
                        .map(|raw| match typed_value(raw) {
                            Val::Empty => "<table:table-cell/>".to_string(),
                            Val::Num(v, _) => format!("<table:table-cell office:value-type=\"float\" office:value=\"{v}\"><text:p>{}</text:p></table:table-cell>", xml_esc(raw)),
                            Val::Bool(b) => format!("<table:table-cell office:value-type=\"boolean\" office:boolean-value=\"{b}\"><text:p>{}</text:p></table:table-cell>", xml_esc(raw)),
                            Val::Str(_) => {
                                let is_date = raw.len() >= 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-' && raw[..4].bytes().all(|c| c.is_ascii_digit()) && (raw.len() == 10 || (raw.len() == 19 && raw.as_bytes()[10] == b' '));
                                if is_date {
                                    format!("<table:table-cell office:value-type=\"date\" office:date-value=\"{}\"><text:p>{}</text:p></table:table-cell>", raw.replace(' ', "T"), xml_esc(raw))
                                } else {
                                    format!("<table:table-cell office:value-type=\"string\">{}</table:table-cell>", raw.split('\n').map(|l| format!("<text:p>{}</text:p>", xml_esc(l.trim_end_matches('\r')))).collect::<String>())
                                }
                            }
                        })
                        .collect();
                    format!("<table:table-row>{}</table:table-row>", if cells.is_empty() { "<table:table-cell/>".into() } else { cells })
                })
                .collect();
            format!(
                "<table:table table:name=\"{}\"><table:table-column table:number-columns-repeated=\"{width}\"/>{}</table:table>",
                xml_esc(&safe_sheet_name(&s.name, &mut used)),
                if rows.is_empty() { "<table:table-row><table:table-cell/></table:table-row>".into() } else { rows }
            )
        })
        .collect();
    let manifest = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.2\"><manifest:file-entry manifest:full-path=\"/\" manifest:version=\"1.2\" manifest:media-type=\"application/vnd.oasis.opendocument.spreadsheet\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/></manifest:manifest>";
    let content = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" office:version=\"1.2\"><office:body><office:spreadsheet>{tables}</office:spreadsheet></office:body></office:document-content>");
    zip_files(out, &[("mimetype", b"application/vnd.oasis.opendocument.spreadsheet".to_vec()), ("META-INF/manifest.xml", manifest.as_bytes().to_vec()), ("content.xml", content.into_bytes())], true)
}

pub fn sheets_to_html(title: &str, sheets: &[Sheet], reading_css: &str) -> String {
    let multi = sheets.len() > 1;
    let numeric = |v: &str| !v.is_empty() && v.trim_start_matches(['-', '+']).trim_end_matches('%').chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') && v.chars().any(|c| c.is_ascii_digit());
    let body: String = sheets
        .iter()
        .map(|s| {
            let rows: String = s.rows.iter().map(|r| format!("<tr>{}</tr>\n", r.iter().map(|v| format!("<td{}>{}</td>", if numeric(v) { " class=\"n\"" } else { "" }, escape_html(v))).collect::<String>())).collect();
            format!("{}<table>{rows}</table>\n", if multi { format!("<h2>{}</h2>", escape_html(&s.name)) } else { String::new() })
        })
        .collect();
    let css = "body{max-width:none;padding:0;font-size:9pt;line-height:1.35}table{border-collapse:collapse;margin-bottom:2em}td{border:1px solid #d9d6d1;padding:2px 6px;white-space:pre-wrap}td.n{text-align:right;font-variant-numeric:tabular-nums}tr:first-child td{background:#f3f1ee;font-weight:600}h2{font-size:12pt;margin:0 0 .6em}h2:not(:first-child){break-before:page}";
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>{reading_css}{css}</style></head><body>{body}</body></html>", escape_html(title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip_and_sniffing() {
        let text = "a;b;c\n1;\"x;y\";3\n4;5;6\n";
        assert_eq!(sniff_delimiter(text), ';');
        let rows = parse_delimited(text, ';');
        assert_eq!(rows[1], vec!["1", "x;y", "3"]);
        assert!(write_delimited(&rows, ',').contains("1,x;y,3"));
        assert_eq!(typed_value("007"), Val::Str("007".into()));
        assert_eq!(typed_value("1.5e3"), Val::Num(1500.0, None));
    }

    #[test]
    fn xlsx_round_trip() {
        let d = crate::convert::testutil::dir("xlsx");
        let out = d.join("a.xlsx");
        rows_to_xlsx(&[Sheet { name: "Data".into(), rows: vec![vec!["Name".into(), "Qty".into()], vec!["Apple & pear".into(), "3".into()]] }], &out).unwrap();
        let back = read_xlsx(&out).unwrap();
        assert_eq!(back[0].name, "Data");
        assert_eq!(back[0].rows[1], vec!["Apple & pear", "3"]);
        assert_eq!(format_serial(45413.5), "2024-05-01 12:00:00");
        std::fs::remove_dir_all(d).unwrap();
    }
}
