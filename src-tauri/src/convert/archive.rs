//! Archives with 7-Zip (downloaded on first use): extract anything 7-Zip reads (zip, rar, 7z, tar,
//! gz, tgz...), repack between formats, and compress files and folders (convert-archive.ts).
//!
//! Public: `convert(paths, target, ctx)` (one archive to extract/repack, or anything to pack),
//! `seven_zip(args, ctx, lo, hi, cwd)` for tools (progress from -bsp1, readable errors).

use super::{file_name, user, Ctx, Fail, R};
use crate::engines::{RunOpts, RunResult, Stream};
use std::path::{Path, PathBuf};

/// Never let 7z sit waiting for a password prompt.
const NO_PASSWORD: &str = "-p__orange_no_password__";

/// Runs 7z with progress from -bsp1 ("  42% 13 - file") mapped onto [lo, hi].
pub fn seven_zip(args: &[String], ctx: &Ctx, lo: f64, hi: f64, cwd: Option<&Path>) -> R<RunResult> {
    let mut a = args.to_vec();
    a.extend(["-bsp1", "-bso0", "-y"].map(String::from));
    let errs = std::sync::Mutex::new(Vec::<String>::new());
    let on = |line: &str, s: Stream| {
        if s == Stream::Stderr {
            errs.lock().unwrap().push(line.trim().to_string());
            return;
        }
        let t = line.trim_start();
        if let Some(i) = t.find('%') {
            if let Ok(p) = t[..i].trim().parse::<f64>() {
                ctx.progress(lo + (hi - lo) * p / 100.0);
            }
        }
    };
    let r = ctx.run("7z", &a, RunOpts { cwd, ok_codes: &[1], on_line: Some(&on), no_stdout: true, ..Default::default() });
    match r {
        Ok(r) => Ok(r),
        Err(Fail::Cancelled) => Err(Fail::Cancelled),
        Err(e) => {
            let all = format!("{} {e}", errs.lock().unwrap().join(" ")).to_lowercase();
            if all.contains("wrong password") || all.contains("encrypted archive") {
                return user("This archive is password-protected.");
            }
            if all.contains("not enough space") || all.contains("disk full") {
                return user("Not enough disk space.");
            }
            if ["is not archive", "can not open the file as", "cannot open the file as", "unexpected end", "headers error", "data error", "crc failed", "unsupported method"].iter().any(|n| all.contains(n)) {
                return user("This archive is damaged or not a supported format.");
            }
            Err(e)
        }
    }
}

/// "photos.tar.gz" → "photos", "data.tgz" → "data", "x.zip" → "x".
pub fn archive_stem(p: &Path) -> String {
    let name = file_name(p);
    let l = name.to_lowercase();
    for suf in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".tbz", ".txz", ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"] {
        if l.ends_with(suf) && l.len() > suf.len() {
            return name[..name.len() - suf.len()].to_string();
        }
    }
    name
}

fn is_tar(file: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return false };
    let mut b = [0u8; 5];
    f.seek(SeekFrom::Start(257)).is_ok() && f.read_exact(&mut b).is_ok() && &b == b"ustar"
}

fn has_ext(p: &Path, exts: &[&str]) -> bool {
    let l = file_name(p).to_lowercase();
    exts.iter().any(|e| l.ends_with(&format!(".{e}")))
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

/// Extracts `archive` into `dir`; a compressed tarball (.tar.gz, .tgz...) is unpacked all the way.
fn extract_into(archive: &Path, dir: &Path, ctx: &Ctx, lo: f64, hi: f64) -> R<()> {
    // -snl-: skip symbolic links (creating one needs admin rights or Developer Mode on Windows).
    seven_zip(&["x".into(), NO_PASSWORD.into(), "-snl-".into(), format!("-o{}", dir.display()), archive.to_string_lossy().into_owned()], ctx, lo, (lo + hi) / 2.0, None)?;
    let items = entries(dir);
    if items.len() == 1 && has_ext(archive, &["gz", "tgz", "bz2", "tbz2", "tbz", "xz", "txz", "zst"]) {
        let inner = &items[0];
        if inner.is_file() && (has_ext(inner, &["tar"]) || is_tar(inner)) {
            seven_zip(&["x".into(), "-snl-".into(), format!("-o{}", dir.display()), inner.to_string_lossy().into_owned()], ctx, (lo + hi) / 2.0, hi, None)?;
            let _ = std::fs::remove_file(inner);
        }
    }
    ctx.progress(hi);
    Ok(())
}

fn unique_beside(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|i| dir.join(format!("{stem} {i}{ext}"))).find(|c| !c.exists()).unwrap()
}

fn extract(input: &Path, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let dir = ctx.out_dir(input, Some(&archive_stem(input)));
    if let Err(e) = extract_into(input, &dir, ctx, 0.0, 0.97) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    let items = entries(&dir);
    if items.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return user("This archive is empty.");
    }
    if items.len() == 1 {
        // A single file or a single top-level folder: put it next to the archive under its own name
        // instead of wrapping it in another folder.
        let parent = dir.parent().unwrap().to_path_buf();
        let parked = parent.join(format!(".orange-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
        std::fs::rename(&items[0], &parked)?;
        let _ = std::fs::remove_dir_all(&dir);
        let dest = unique_beside(&parent, &file_name(&items[0]));
        std::fs::rename(&parked, &dest)?;
        ctx.progress(1.0);
        return Ok(vec![dest]);
    }
    ctx.progress(1.0);
    Ok(vec![dir])
}

/// Compresses `items` into a new archive named `base` (each item stored under its own name).
fn pack(items: &[PathBuf], target: &str, base: &str, near: &Path, ctx: &Ctx, lo: f64) -> R<PathBuf> {
    let parent = near.parent().map(Path::to_path_buf).unwrap_or_default();
    let common = ["-mmt=on".to_string(), "-ssw".to_string()]; // all cores; also read files other apps have open
    let s = |p: &Path| p.to_string_lossy().into_owned();
    if target == "gz" {
        if items.len() == 1 && items[0].is_file() {
            let out = ctx.out(&parent.join(format!("{}.x", file_name(&items[0]))), "gz", "");
            let mut a = vec!["a".into(), "-tgzip".into(), "-mx=6".into()];
            a.extend(common.clone());
            a.extend([s(&out), s(&items[0])]);
            super::remove_on_failure(&out, || seven_zip(&a, ctx, lo, 1.0, None).map(|_| ()))?;
            return Ok(out);
        }
        // Several files or a folder: a .tar.gz, built as tar in temp, then gzipped.
        let tar = ctx.tmp().join(format!("{base}.tar"));
        let mut a = vec!["a".into(), "-ttar".into()];
        a.extend(common.clone());
        a.push(s(&tar));
        a.extend(items.iter().map(|p| s(p)));
        seven_zip(&a, ctx, lo, lo + (1.0 - lo) * 0.4, None)?;
        let out = ctx.out(&parent.join(format!("{base}.tar.x")), "gz", "");
        let mut a = vec!["a".into(), "-tgzip".into(), "-mx=6".into()];
        a.extend(common);
        a.extend([s(&out), s(&tar)]);
        super::remove_on_failure(&out, || seven_zip(&a, ctx, lo + (1.0 - lo) * 0.4, 1.0, None).map(|_| ()))?;
        return Ok(out);
    }
    let out = ctx.out(&parent.join(format!("{base}.x")), target, "");
    let ty: &[&str] = match target {
        "zip" => &["-tzip", "-mx=5", "-mcu=on"],
        "tar" => &["-ttar"],
        _ => &["-t7z", "-mx=5"],
    };
    let mut a: Vec<String> = vec!["a".into()];
    a.extend(ty.iter().map(|x| x.to_string()));
    a.extend(common);
    a.push(s(&out));
    a.extend(items.iter().map(|p| s(p)));
    super::remove_on_failure(&out, || seven_zip(&a, ctx, lo, 1.0, None).map(|_| ()))?;
    Ok(out)
}

fn repack(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let work = ctx.tmp();
    extract_into(input, &work, ctx, 0.0, 0.5)?;
    let items = entries(&work);
    if items.is_empty() {
        return user("This archive is empty.");
    }
    Ok(vec![pack(&items, target, &archive_stem(input), input, ctx, 0.5)?])
}

fn list_name(paths: &[PathBuf]) -> String {
    if paths.len() == 1 {
        return super::stem_of(&paths[0]);
    }
    match paths[0].parent().and_then(|p| p.file_name()) {
        Some(n) => format!("Archive ({})", n.to_string_lossy()),
        None => "Archive".into(),
    }
}

pub fn convert(paths: &[PathBuf], target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    if let Some(m) = paths.iter().find(|p| !p.exists()) {
        return user(format!("{} no longer exists.", file_name(m)));
    }
    if !["extract", "zip", "tar", "gz", "7z"].contains(&target) {
        return user(format!("Can't make a {} archive.", target.to_uppercase()));
    }
    let single = (paths.len() == 1).then(|| &paths[0]);
    let is_archive = single.map(|p| p.is_file() && has_ext(p, &["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz", "tbz2", "tbz", "txz"])).unwrap_or(false);
    if target == "extract" {
        if !is_archive {
            return user("That is not an archive.");
        }
        return extract(single.unwrap(), ctx);
    }
    if is_archive {
        return repack(single.unwrap(), target, ctx);
    }
    Ok(vec![pack(paths, target, &list_name(paths), &paths[0], ctx, 0.0)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems() {
        assert_eq!(archive_stem(Path::new("a/photos.tar.gz")), "photos");
        assert_eq!(archive_stem(Path::new("data.TGZ")), "data");
        assert_eq!(archive_stem(Path::new("x.zip")), "x");
    }
}
