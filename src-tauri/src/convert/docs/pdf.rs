//! PDFs with Ghostscript (downloaded on first use): page sizes, page images, and positioned text
//! (the `txtwrite` device), plus the 1.x text-structure reconstruction that used pdf.js: lines,
//! paragraphs, lists, headings, running headers/footers and tables.

use super::super::{long_safe, user, Ctx, Fail, R};
use crate::engines::{RunOpts, Stream};
use std::path::{Path, PathBuf};

fn ps_string(p: &Path) -> String {
    // Long paths need the \\?\ prefix, whose backslashes must stay (forward slashes break it).
    let s = long_safe(p);
    if s.starts_with(r"\\?\") {
        return s.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)");
    }
    s.replace('\\', "/").replace('(', "\\(").replace(')', "\\)")
}

fn permit_arg(p: &Path) -> String {
    let l = long_safe(p);
    format!("--permit-file-read={}", if l.starts_with(r"\\?\") { l } else { l.replace('\\', "/") })
}

fn gs(ctx: &Ctx, args: Vec<String>, on: Option<&dyn Fn(&str, Stream)>) -> R<crate::engines::RunResult> {
    match ctx.run("gs", &args, RunOpts { on_line: on, ..Default::default() }) {
        Err(Fail::Raw(m)) => {
            let l = m.to_lowercase();
            if l.contains("password") {
                return user("The PDF is password-protected.");
            }
            Err(Fail::Raw(format!("ghostscript: {m}")))
        }
        r => r,
    }
}

fn gs_error_text(out: &str) -> Option<Fail> {
    let l = out.to_lowercase();
    if l.contains("password") {
        return Some(Fail::User("The PDF is password-protected.".into()));
    }
    None
}

/// Size in points (MediaBox) of every page.
pub fn page_sizes(input: &Path, ctx: &Ctx) -> R<Vec<(f64, f64)>> {
    let p = ps_string(input);
    let script = format!("({p}) (r) file runpdfbegin 1 1 pdfpagecount {{ pdfgetpage /MediaBox pget {{ == }} {{ ([0 0 612 792]) = }} ifelse }} for quit");
    let r = gs(ctx, vec!["-q".into(), "-dNODISPLAY".into(), "-dSAFER".into(), "-dNOPAUSE".into(), "-dBATCH".into(), permit_arg(input), "-c".into(), script], None);
    let r = match r {
        Ok(r) => r,
        Err(Fail::Raw(m)) => {
            if let Some(f) = gs_error_text(&m) {
                return Err(f);
            }
            return user("This file isn't a valid PDF, or it is damaged.");
        }
        Err(e) => return Err(e),
    };
    let out = r.stdout_text();
    if let Some(f) = gs_error_text(&out) {
        return Err(f);
    }
    let mut sizes = vec![];
    for line in out.lines() {
        let t = line.trim().trim_start_matches('[').trim_end_matches(']');
        let v: Vec<f64> = t.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() == 4 {
            sizes.push(((v[2] - v[0]).abs().max(1.0), (v[3] - v[1]).abs().max(1.0)));
        }
    }
    if sizes.is_empty() {
        return user("This file isn't a valid PDF, or it is damaged.");
    }
    Ok(sizes)
}

/// Rasterises PDF pages. Returns the image paths in page order.
pub fn render(input: &Path, out_dir: &Path, fmt: &str, ctx: &Ctx, prog: &dyn Fn(f64), dpi: u32, prefix: &str, pages: usize) -> R<Vec<PathBuf>> {
    let pad = pages.to_string().len().max(2);
    // Ghostscript expands %d in the output name, so escape any literal %.
    let pattern = long_safe(&out_dir.join(format!("{}%0{pad}d.{fmt}", prefix.replace('%', "%%"))));
    let pattern = if out_dir.to_string_lossy().contains('%') {
        let d = out_dir.to_string_lossy().replace('%', "%%");
        format!("{d}\\{}%0{pad}d.{fmt}", prefix.replace('%', "%%"))
    } else {
        pattern
    };
    let dev: Vec<String> = if fmt == "png" { vec!["-sDEVICE=png16m".into()] } else { vec!["-sDEVICE=jpeg".into(), "-dJPEGQ=92".into()] };
    let done = std::cell::Cell::new(0usize);
    let on = |line: &str, _: Stream| {
        if line.starts_with("Page ") {
            done.set(done.get() + 1);
            prog(done.get() as f64 / pages.max(1) as f64);
        }
    };
    let mut a: Vec<String> = vec!["-dSAFER".into(), "-dBATCH".into(), "-dNOPAUSE".into()];
    a.extend(dev);
    a.extend([format!("-r{dpi}"), "-dTextAlphaBits=4".into(), "-dGraphicsAlphaBits=4".into(), "-dUseCropBox".into(), "-dNumRenderingThreads=4".into(), format!("-sOutputFile={pattern}"), long_safe(input)]);
    gs(ctx, a, Some(&on))?;
    let files: Vec<PathBuf> = (1..=pages).map(|i| out_dir.join(format!("{prefix}{:0pad$}.{fmt}", i))).filter(|f| f.exists()).collect();
    if files.is_empty() {
        return user("Couldn't render this PDF.");
    }
    Ok(files)
}

// ------------------------------------------------------------------ text

#[derive(Clone, Debug)]
pub struct TItem {
    pub s: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub size: f64,
}

#[derive(Clone, Debug)]
pub struct PLine {
    pub text: String,
    pub cells: Vec<String>,
    pub boxes: Vec<(f64, f64)>,
    pub row: bool,
    pub x: f64,
    pub right: f64,
    pub y: f64,
    pub size: f64,
}

pub struct PdfPage {
    pub items: Vec<TItem>,
    pub lines: Vec<PLine>,
    pub width: f64,
    pub height: f64,
}

pub struct PdfText {
    pub pages: Vec<PdfPage>,
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')?;
    Some(&tag[i..i + j])
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find(';') else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let ent = &rest[i + 1..i + j];
        let c = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
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

/// Positioned text of every page (txtwrite's span/char XML), in content order, y measured upwards.
pub fn read_text(input: &Path, ctx: &Ctx, prog: &dyn Fn(f64)) -> R<PdfText> {
    let sizes = page_sizes(input, ctx)?;
    prog(0.1);
    let out = ctx.tmp().join("text.xml");
    gs(ctx, vec!["-q".into(), "-dSAFER".into(), "-dBATCH".into(), "-dNOPAUSE".into(), "-sDEVICE=txtwrite".into(), "-dTextFormat=0".into(), format!("-sOutputFile={}", long_safe(&out)), long_safe(input)], None)?;
    prog(0.8);
    let xml = String::from_utf8_lossy(&std::fs::read(&out)?).into_owned();
    let mut pages = vec![];
    for (pi, chunk) in xml.split("<page").skip(1).enumerate() {
        let (pw, ph) = sizes.get(pi).copied().unwrap_or((612.0, 792.0));
        let mut items = vec![];
        for span in chunk.split("<span").skip(1) {
            let head_end = span.find('>').unwrap_or(0);
            let head = &span[..head_end];
            let size = attr(head, "size").and_then(|s| s.parse::<f64>().ok()).unwrap_or(10.0);
            // A span can hold runs on different baselines; split where the baseline or x jumps.
            let mut cur: Option<TItem> = None;
            for ch in span[head_end..].split("<char").skip(1) {
                let Some(bb) = attr(ch, "bbox") else { continue };
                let v: Vec<f64> = bb.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                if v.len() != 4 {
                    continue;
                }
                let c = unescape(attr(ch, "c").unwrap_or(""));
                let y = ph - v[3];
                match &mut cur {
                    Some(it) if (it.y - y).abs() < 0.5 && v[0] >= it.x + it.w - size * 0.3 && v[0] <= it.x + it.w + size * 0.6 => {
                        it.s.push_str(&c);
                        it.w = (v[2] - it.x).max(it.w);
                    }
                    _ => {
                        if let Some(it) = cur.take() {
                            items.push(it);
                        }
                        cur = Some(TItem { s: c, x: v[0], y, w: (v[2] - v[0]).max(0.0), size });
                    }
                }
            }
            if let Some(it) = cur.take() {
                items.push(it);
            }
        }
        let lines = items_to_lines(&items);
        pages.push(PdfPage { items, lines, width: pw, height: ph });
    }
    while pages.len() < sizes.len() {
        let (w, h) = sizes[pages.len()];
        pages.push(PdfPage { items: vec![], lines: vec![], width: w, height: h });
    }
    prog(1.0);
    Ok(PdfText { pages })
}

fn join_items(items: &[&TItem]) -> String {
    let mut text = String::new();
    let mut prev: Option<&TItem> = None;
    for it in items {
        if let Some(p) = prev {
            let gap = it.x - (p.x + p.w);
            if gap > it.size.min(p.size) * 0.12 && !text.ends_with(char::is_whitespace) && !it.s.starts_with(char::is_whitespace) {
                text.push(' ');
            }
        }
        text.push_str(&it.s);
        prev = Some(it);
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn make_line(items: &[&TItem]) -> PLine {
    let mut sorted: Vec<&TItem> = items.to_vec();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut size = 0.0;
    let mut longest: i64 = -1;
    for it in &sorted {
        let n = it.s.trim().chars().count() as i64;
        if n > longest {
            longest = n;
            size = it.size;
        }
    }
    let last = sorted[sorted.len() - 1];
    let mut cells = vec![];
    let mut boxes = vec![];
    let mut group: Vec<&TItem> = vec![];
    let flush = |group: &mut Vec<&TItem>, cells: &mut Vec<String>, boxes: &mut Vec<(f64, f64)>| {
        let ink: Vec<&&TItem> = group.iter().filter(|g| !g.s.trim().is_empty()).collect();
        if let (Some(f), Some(l)) = (ink.first(), ink.last()) {
            cells.push(join_items(group));
            boxes.push((f.x, l.x + l.w));
        }
        group.clear();
    };
    for it in &sorted {
        if it.s.trim().is_empty() {
            group.push(it);
            continue;
        }
        let prev = group.iter().rev().find(|g| !g.s.trim().is_empty()).copied();
        if let Some(p) = prev {
            if it.x - (p.x + p.w) > it.size.max(p.size) * 0.8 {
                flush(&mut group, &mut cells, &mut boxes);
            }
        }
        group.push(it);
    }
    flush(&mut group, &mut cells, &mut boxes);
    PLine { text: join_items(&sorted), cells, boxes, row: false, x: sorted[0].x, right: last.x + last.w, y: sorted[0].y, size }
}

fn is_list_number(s: &str) -> bool {
    let t = s.trim();
    let Some(body) = t.strip_suffix('.').or_else(|| t.strip_suffix(')')) else { return false };
    (!body.is_empty() && body.len() <= 3 && body.bytes().all(|c| c.is_ascii_digit()))
        || (body.len() == 1 && body.bytes().all(|c| c.is_ascii_alphabetic()))
        || (!body.is_empty() && body.len() <= 5 && body.chars().all(|c| "ivxIVX".contains(c)))
}

/// Marks table rows: runs of 2+ consecutive lines with the same number (2+) of aligned cells.
fn detect_tables(lines: &mut [&mut PLine]) {
    let candidate = |l: &PLine| l.cells.len() >= 2 && !(l.cells.len() == 2 && is_list_number(&l.cells[0]));
    let mut i = 0;
    while i < lines.len() {
        if !candidate(lines[i]) {
            i += 1;
            continue;
        }
        let n = lines[i].cells.len();
        let tol = lines[i].size * 0.75;
        let mut j = i + 1;
        while j < lines.len() && candidate(lines[j]) && lines[j].cells.len() == n && lines[i].boxes.iter().zip(&lines[j].boxes).all(|(a, b)| (a.0 - b.0).abs() <= tol || (a.1 - b.1).abs() <= tol) {
            j += 1;
        }
        if j - i >= 2 {
            for l in &mut lines[i..j] {
                l.row = true;
            }
        }
        i = j;
    }
}

/// Text items into visual lines, keeping the content-stream order (which follows columns).
fn items_to_lines(items: &[TItem]) -> Vec<PLine> {
    let mut lines = vec![];
    let mut cur: Vec<&TItem> = vec![];
    for it in items {
        if it.s.is_empty() {
            continue;
        }
        if let Some(last) = cur.last() {
            let dy = (it.y - last.y).abs();
            let tol = (it.size.min(last.size) * 0.45).max(1.0);
            let backwards = it.x < last.x - last.size;
            if dy > tol || (backwards && dy > 0.5) {
                if cur.iter().any(|i| !i.s.trim().is_empty()) {
                    lines.push(make_line(&cur));
                }
                cur.clear();
            }
        }
        cur.push(it);
    }
    if cur.iter().any(|i| !i.s.trim().is_empty()) {
        lines.push(make_line(&cur));
    }
    lines
}

fn furniture_key(l: &PLine) -> String {
    let mut out = String::new();
    let mut in_num = false;
    for c in l.text.to_lowercase().chars() {
        if c.is_ascii_digit() {
            if !in_num {
                out.push('#');
            }
            in_num = true;
        } else {
            in_num = false;
            out.push(c);
        }
    }
    out
}

fn is_page_no(k: &str) -> bool {
    let t = k.trim();
    let t2 = t.trim_start_matches("page").trim();
    let simple = |s: &str| {
        let s = s.trim();
        s == "#" || {
            let parts: Vec<&str> = s.split(['/']).collect();
            (parts.len() == 2 && parts.iter().all(|p| p.trim() == "#")) || {
                let p: Vec<&str> = s.split(" of ").collect();
                p.len() == 2 && p.iter().all(|x| x.trim() == "#")
            }
        }
    };
    simple(t2) || simple(t.trim_matches(|c: char| c == '-' || c == '–' || c == '—' || c.is_whitespace()))
}

/// Text repeated at the top/bottom of most pages (running headers, footers, page numbers).
fn furniture(pages: &[PdfPage]) -> Vec<Vec<bool>> {
    let mut drop: Vec<Vec<bool>> = pages.iter().map(|p| vec![false; p.lines.len()]).collect();
    let edges: Vec<Vec<usize>> = pages
        .iter()
        .map(|pg| {
            if pg.lines.is_empty() {
                return vec![];
            }
            let mut by_y: Vec<usize> = (0..pg.lines.len()).collect();
            by_y.sort_by(|&a, &b| pg.lines[b].y.total_cmp(&pg.lines[a].y));
            let mut e = vec![by_y[0], by_y[by_y.len() - 1]];
            if by_y.len() > 3 {
                e.extend([by_y[1], by_y[by_y.len() - 2]]);
            }
            e.sort();
            e.dedup();
            let band = pg.height * 0.1;
            e.into_iter().filter(|&i| pg.lines[i].y > pg.height - band - pg.lines[i].size || pg.lines[i].y < band).collect()
        })
        .collect();
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for (p, e) in edges.iter().enumerate() {
        let keys: std::collections::HashSet<String> = e.iter().map(|&i| furniture_key(&pages[p].lines[i])).collect();
        for k in keys {
            *counts.entry(k).or_default() += 1;
        }
    }
    let need = 3usize.max(pages.len().div_ceil(2));
    for (p, e) in edges.iter().enumerate() {
        for &i in e {
            let k = furniture_key(&pages[p].lines[i]);
            if is_page_no(&k) || (pages.len() >= 3 && counts.get(&k).copied().unwrap_or(0) >= need) {
                drop[p][i] = true;
            }
        }
    }
    drop
}

#[derive(Clone, Debug, PartialEq)]
pub enum ParaKind {
    P,
    Li,
    H1,
    H2,
    H3,
    Row,
}

#[derive(Clone, Debug)]
pub struct Para {
    pub text: String,
    pub size: f64,
    pub kind: ParaKind,
    pub cells: Vec<String>,
}

/// A leading bullet (including Word's private-use Symbol/Wingdings glyphs) and its length in bytes.
fn bullet(s: &str) -> Option<usize> {
    let mut it = s.char_indices();
    let (_, c) = it.next()?;
    let len = c.len_utf8();
    let is = "•◦▪▫●○■□‣⁃∙·*".contains(c) || ('\u{F000}'..='\u{F0FF}').contains(&c);
    let dash = "-–—".contains(c) && s[len..].starts_with(char::is_whitespace);
    if !is && !dash {
        return None;
    }
    Some(len + (s[len..].len() - s[len..].trim_start().len()))
}

fn ends_sentence(s: &str) -> bool {
    s.chars().last().map(|c| ".!?:;。！？”\"')]".contains(c)).unwrap_or(false)
}

/// Paragraphs, list items, headings and table rows from visual lines.
pub fn lines_to_paras(doc: &mut PdfText) -> Vec<Para> {
    let drop = furniture(&doc.pages);
    let mut paras: Vec<Para> = vec![];
    struct Cur {
        p: Para,
        last: PLine,
    }
    let mut cur: Option<Cur> = None;
    let push = |cur: &mut Option<Cur>, paras: &mut Vec<Para>| {
        if let Some(c) = cur.take() {
            if !c.p.text.trim().is_empty() {
                paras.push(Para { text: c.p.text.trim().to_string(), ..c.p });
            }
        }
    };
    for (pi, page) in doc.pages.iter_mut().enumerate() {
        let page_right = page.lines.iter().map(|l| l.right).fold(0.0, f64::max);
        {
            let mut kept: Vec<&mut PLine> = page.lines.iter_mut().enumerate().filter(|(i, _)| !drop[pi][*i]).map(|(_, l)| l).collect();
            detect_tables(&mut kept);
        }
        let mut first_on_page = true;
        for (li, line) in page.lines.iter().enumerate() {
            if drop[pi][li] {
                continue;
            }
            let b = bullet(&line.text);
            let text = match b {
                Some(n) => line.text[n..].to_string(),
                None => line.text.clone(),
            };
            if text.is_empty() {
                continue;
            }
            if line.row {
                push(&mut cur, &mut paras);
                paras.push(Para { text: line.cells.join(" "), size: line.size, kind: ParaKind::Row, cells: line.cells.clone() });
                first_on_page = false;
                continue;
            }
            let mut fresh = true;
            if let Some(c) = &cur {
                let prev = &c.last;
                let lh = prev.size.max(line.size);
                if first_on_page {
                    // Carry a sentence over the page break.
                    let starts_lower = text.chars().next().map(|ch| ch.is_lowercase() || ch == '(').unwrap_or(false);
                    fresh = ends_sentence(&c.p.text) || !starts_lower || (prev.size - line.size).abs() > lh * 0.15;
                } else {
                    let gap = prev.y - line.y;
                    fresh = b.is_some()
                        || gap < -lh * 0.5
                        || gap > lh * 1.75
                        || (prev.size - line.size).abs() > lh * 0.15
                        || line.x - prev.x > lh * 1.2
                        || (prev.right < page_right - lh * 4.0 && ends_sentence(&prev.text));
                }
            }
            if fresh {
                push(&mut cur, &mut paras);
                cur = Some(Cur { p: Para { text, size: line.size, kind: if b.is_some() { ParaKind::Li } else { ParaKind::P }, cells: vec![] }, last: line.clone() });
            } else if let Some(c) = &mut cur {
                let hyphen = c.p.text.ends_with('-') && c.p.text.chars().rev().nth(1).map(|ch| ch.is_ascii_lowercase()).unwrap_or(false) && text.starts_with(|ch: char| ch.is_ascii_lowercase());
                if hyphen {
                    c.p.text.pop();
                    c.p.text.push_str(&text);
                } else {
                    c.p.text.push(' ');
                    c.p.text.push_str(&text);
                }
                c.last = line.clone();
            }
            first_on_page = false;
        }
    }
    push(&mut cur, &mut paras);

    // Body size = the size carrying the most characters; larger short paragraphs are headings.
    let half = |s: f64| (s * 2.0).round() / 2.0;
    let mut weight: Vec<(f64, usize)> = vec![];
    for p in &paras {
        let k = half(p.size);
        match weight.iter_mut().find(|w| w.0 == k) {
            Some(w) => w.1 += p.text.chars().count(),
            None => weight.push((k, p.text.chars().count())),
        }
    }
    let body = weight.iter().max_by_key(|w| w.1).map(|w| w.0).unwrap_or(10.0);
    let is_heading = |p: &Para| p.kind == ParaKind::P && p.size >= body * 1.18 && p.text.chars().count() <= 160 && !p.text.ends_with(['.', ',', ';']);
    let mut sizes: Vec<f64> = paras.iter().filter(|p| is_heading(p)).map(|p| half(p.size)).collect();
    sizes.sort_by(|a, b| b.total_cmp(a));
    sizes.dedup();
    for p in paras.iter_mut() {
        if !is_heading(p) {
            continue;
        }
        let rank = sizes.iter().position(|s| *s == half(p.size)).unwrap_or(0);
        p.kind = match rank {
            0 => ParaKind::H1,
            1 => ParaKind::H2,
            _ => ParaKind::H3,
        };
    }
    paras
}

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn paras_to_html(paras: &[Para], title: &str) -> String {
    let mut out = vec![];
    let mut i = 0;
    while i < paras.len() {
        let p = &paras[i];
        match p.kind {
            ParaKind::Li => {
                out.push("<ul>".to_string());
                while i < paras.len() && paras[i].kind == ParaKind::Li {
                    out.push(format!("<li>{}</li>", escape_html(&paras[i].text)));
                    i += 1;
                }
                out.push("</ul>".into());
            }
            ParaKind::Row => {
                let mut rows: Vec<Vec<String>> = vec![];
                while i < paras.len() && paras[i].kind == ParaKind::Row {
                    rows.push(if paras[i].cells.is_empty() { vec![paras[i].text.clone()] } else { paras[i].cells.clone() });
                    i += 1;
                }
                if rows.len() == 1 {
                    out.push(format!("<p>{}</p>", escape_html(&rows[0].join(" "))));
                    continue;
                }
                let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
                let tr = |r: &Vec<String>, tag: &str| format!("<tr>{}</tr>", (0..width).map(|c| format!("<{tag}>{}</{tag}>", escape_html(r.get(c).map(String::as_str).unwrap_or("")))).collect::<String>());
                out.push(format!("<table><thead>{}</thead><tbody>{}</tbody></table>", tr(&rows[0], "th"), rows[1..].iter().map(|r| tr(r, "td")).collect::<String>()));
            }
            _ => {
                let tag = match p.kind {
                    ParaKind::H1 => "h1",
                    ParaKind::H2 => "h2",
                    ParaKind::H3 => "h3",
                    _ => "p",
                };
                out.push(format!("<{tag}>{}</{tag}>", escape_html(&p.text)));
                i += 1;
            }
        }
    }
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body>\n{}\n</body></html>", escape_html(title), out.join("\n"))
}

pub fn paras_to_text(paras: &[Para]) -> String {
    let mut out = vec![];
    for (i, p) in paras.iter().enumerate() {
        let text = match p.kind {
            ParaKind::Li => format!("• {}", p.text),
            ParaKind::Row => if p.cells.is_empty() { p.text.clone() } else { p.cells.join("\t") },
            _ => p.text.clone(),
        };
        // List items and table rows stay together; a blank line separates everything else.
        let tight = i > 0 && p.kind == paras[i - 1].kind && (p.kind == ParaKind::Li || p.kind == ParaKind::Row);
        out.push(if i == 0 || tight { text } else { format!("\n{text}") });
    }
    out.join("\n") + "\n"
}

pub fn no_text() -> Fail {
    Fail::User("This PDF has no selectable text (it's probably a scan), so there's nothing to extract.".into())
}

// ------------------------------------------------------------------ PDF → table rows

/// Tables from text positions: rows by baseline, columns by vertical whitespace.
pub fn page_to_rows(page: &PdfPage) -> Vec<Vec<String>> {
    let mut items: Vec<&TItem> = page.items.iter().filter(|i| !i.s.trim().is_empty()).collect();
    if items.is_empty() {
        return vec![];
    }
    items.sort_by(|a, b| b.y.total_cmp(&a.y).then(a.x.total_cmp(&b.x)));
    let mut rows: Vec<Vec<&TItem>> = vec![];
    for it in items {
        match rows.last_mut() {
            Some(r) if (r[0].y - it.y).abs() <= (r[0].size.min(it.size) * 0.45).max(1.5) => r.push(it),
            _ => rows.push(vec![it]),
        }
    }
    struct Cell {
        text: String,
        x: f64,
        right: f64,
    }
    let cell_rows: Vec<Vec<Cell>> = rows
        .iter_mut()
        .map(|r| {
            r.sort_by(|a, b| a.x.total_cmp(&b.x));
            let mut cells = vec![];
            let mut group: Vec<&TItem> = vec![];
            let flush = |g: &mut Vec<&TItem>, cells: &mut Vec<Cell>| {
                if let (Some(f), Some(l)) = (g.first(), g.last()) {
                    cells.push(Cell { text: join_items(g), x: f.x, right: l.x + l.w });
                }
                g.clear();
            };
            for it in r.iter() {
                if let Some(p) = group.last() {
                    if it.x - (p.x + p.w) > it.size.max(p.size) * 0.9 {
                        flush(&mut group, &mut cells);
                    }
                }
                group.push(it);
            }
            flush(&mut group, &mut cells);
            cells
        })
        .collect();
    let mut covered: Vec<(f64, f64)> = cell_rows.iter().filter(|r| r.len() >= 2).flat_map(|r| r.iter().map(|c| (c.x, c.right))).collect();
    covered.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut seps = vec![];
    let mut reach = f64::NEG_INFINITY;
    for (s, e) in covered {
        if reach > f64::NEG_INFINITY && s - reach > 2.0 {
            seps.push((s + reach) / 2.0);
        }
        reach = reach.max(e);
    }
    let col_of = |x: f64| seps.iter().take_while(|&&s| x > s).count();
    cell_rows
        .iter()
        .map(|r| {
            let mut out: Vec<String> = vec![];
            for c in r {
                let col = col_of(if r.len() >= 2 { (c.x + c.right) / 2.0 } else { c.x });
                if out.len() <= col {
                    out.resize(col + 1, String::new());
                }
                out[col] = if out[col].is_empty() { c.text.clone() } else { format!("{} {}", out[col], c.text) };
            }
            out
        })
        .collect()
}

/// "1,234.50", "(12)", "45%", "$3" as a number and an Excel number format.
pub fn parse_numberish(s: &str) -> Option<(f64, Option<String>)> {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > 24 {
        return None;
    }
    let mut rest = t;
    let mut neg = false;
    if let Some(r) = rest.strip_prefix('-') {
        neg = true;
        rest = r;
    } else if let Some(r) = rest.strip_prefix('+') {
        rest = r;
    }
    let paren = rest.starts_with('(') && rest.ends_with(')');
    if paren {
        rest = &rest[1..rest.len() - 1];
        neg = true;
    } else if rest.starts_with('(') || rest.ends_with(')') {
        return None;
    }
    for cur in ['$', '€', '£', '¥', '₹'] {
        if let Some(r) = rest.strip_prefix(cur) {
            rest = r.trim_start();
            break;
        }
    }
    let pct = rest.ends_with('%');
    if pct {
        rest = &rest[..rest.len() - 1];
    }
    let (int, frac) = match rest.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    if let Some(f) = frac {
        if f.is_empty() || !f.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    let grouped = int.contains(',');
    if grouped {
        let g: Vec<&str> = int.split(',').collect();
        if g[0].is_empty() || g[0].len() > 3 || g[1..].iter().any(|x| x.len() != 3) || !g.iter().all(|x| x.bytes().all(|c| c.is_ascii_digit())) {
            return None;
        }
    } else if int.is_empty() || !int.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if int.starts_with('0') && int.len() > 1 && frac.is_none() {
        return None; // leading zeros: an ID, keep as text
    }
    let mut v: f64 = format!("{}{}", int.replace(',', ""), frac.map(|f| format!(".{f}")).unwrap_or_default()).parse().ok()?;
    if neg {
        v = -v;
    }
    let dec = frac.map(|f| f.len()).unwrap_or(0);
    if pct {
        return Some((v / 100.0, Some(if dec > 0 { format!("0.{}%", "0".repeat(dec)) } else { "0%".into() })));
    }
    if grouped {
        return Some((v, Some(if dec > 0 { format!("#,##0.{}", "0".repeat(dec)) } else { "#,##0".into() })));
    }
    Some((v, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numberish() {
        assert_eq!(parse_numberish("1,200.50"), Some((1200.5, Some("#,##0.00".into()))));
        assert_eq!(parse_numberish("45%"), Some((0.45, Some("0%".into()))));
        assert_eq!(parse_numberish("(12)"), Some((-12.0, None)));
        assert_eq!(parse_numberish("007"), None);
        assert_eq!(parse_numberish("abc"), None);
    }

    #[test]
    fn page_numbers_are_furniture() {
        assert!(is_page_no("#"));
        assert!(is_page_no("page # of #"));
        assert!(is_page_no("- # -"));
        assert!(!is_page_no("chapter #"));
    }
}
