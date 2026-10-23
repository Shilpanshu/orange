//! HEIC writer (engines/heif.ts): libx265 (through FFmpeg) encodes the picture as HEVC tiles, and
//! this file wraps them in a HEIF container the way phones do (a 'grid' image of hidden 'hvc1'
//! tiles, nclx colour, optional Exif). ImageMagick's Windows build only reads HEIC.
//!
//! Public: `encode_heic(rgb, width, height, quality, exif, ctx) -> R<Vec<u8>>`.

use super::{Ctx, Fail, R};

/// 512 like phones, larger for big pictures: libheif refuses files with more than 256 items.
fn tile_for(w: u32, h: u32) -> u32 {
    for t in [512, 1024, 2048] {
        if w.div_ceil(t) * h.div_ceil(t) <= 250 {
            return t;
        }
    }
    4096
}

/// Packed 8-bit sRGB pixels (w*h*3) to HEIC bytes.
pub fn encode_heic(rgb: &[u8], width: u32, height: u32, quality: u32, exif: Option<&[u8]>, ctx: &Ctx) -> R<Vec<u8>> {
    let tile = tile_for(width, height);
    let (cols, rows) = (width.div_ceil(tile), height.div_ceil(tile));
    let (pw, ph) = (cols * tile, rows * tile);
    let crf = (51.0 - quality as f64 * 0.33).clamp(8.0, 40.0).round() as i64;
    let mp4 = ctx.tmp().join("tiles.mp4");
    let vf = format!("scale=out_color_matrix=bt601:out_range=full:flags=accurate_rnd+full_chroma_int,format=yuv420p,untile={cols}x{rows}");
    let padded = pad_rgb(rgb, width, height, pw, ph);
    let a: Vec<String> = [
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &format!("{pw}x{ph}"), "-i", "pipe:0", "-vf", &vf, "-c:v", "libx265", "-preset", "fast", "-crf", &crf.to_string(), "-x265-params",
        "keyint=1:min-keyint=1:bframes=0:info=0:log-level=error:range=full:colorprim=bt709:transfer=iec61966-2-1:colormatrix=smpte170m", "-color_range", "pc", "-colorspace", "smpte170m",
        "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-tag:v", "hvc1", "-an", "-f", "mp4", &mp4.to_string_lossy(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    super::av::ffmpeg_with(&a, ctx, 0.0, (0.45, 0.9), Some(&padded))?;
    let buf = std::fs::read(&mp4)?;
    let (hvcc, samples) = read_hevc_track(&buf).map_err(Fail::Raw)?;
    if samples.len() != (cols * rows) as usize {
        return Err(Fail::Raw(format!("HEIC encode produced {} tiles, expected {}.", samples.len(), cols * rows)));
    }
    let exif = exif.and_then(exif_payload);
    Ok(build_heif(&hvcc, &samples, tile, cols, rows, width, height, exif.as_deref()))
}

/// Grows the picture to whole tiles by repeating the last column/row.
fn pad_rgb(rgb: &[u8], w: u32, h: u32, pw: u32, ph: u32) -> Vec<u8> {
    if pw == w && ph == h {
        return rgb.to_vec();
    }
    let (w, h, pw, ph) = (w as usize, h as usize, pw as usize, ph as usize);
    let mut out = vec![0u8; pw * ph * 3];
    let row = w * 3;
    for y in 0..ph {
        let sy = y.min(h - 1);
        let d = y * pw * 3;
        out[d..d + row].copy_from_slice(&rgb[sy * row..sy * row + row]);
        let last = [rgb[sy * row + row - 3], rgb[sy * row + row - 2], rgb[sy * row + row - 1]];
        for x in w..pw {
            out[d + x * 3..d + x * 3 + 3].copy_from_slice(&last);
        }
    }
    out
}

// ------------------------------------------------------------------ MP4 reading

#[derive(Clone, Copy)]
struct Box_ {
    ty: [u8; 4],
    start: usize,
    end: usize,
}

fn be32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn children(b: &[u8], start: usize, end: usize) -> Vec<Box_> {
    let mut out = vec![];
    let mut p = start;
    while p + 8 <= end {
        let mut size = be32(b, p) as usize;
        let mut header = 8;
        if size == 1 {
            size = u64::from_be_bytes(b[p + 8..p + 16].try_into().unwrap()) as usize;
            header = 16;
        } else if size == 0 {
            size = end - p;
        }
        if size < header || p + size > end {
            break;
        }
        out.push(Box_ { ty: b[p + 4..p + 8].try_into().unwrap(), start: p + header, end: p + size });
        p += size;
    }
    out
}

fn find(b: &[u8], parent: Box_, path: &[&str]) -> Option<Box_> {
    let mut cur = parent;
    for t in path {
        cur = children(b, cur.start, cur.end).into_iter().find(|x| &x.ty == t.as_bytes())?;
    }
    Some(cur)
}

/// The hvcC record and every sample of a one-track MP4.
fn read_hevc_track(b: &[u8]) -> Result<(Vec<u8>, Vec<Vec<u8>>), String> {
    let root = Box_ { ty: *b"root", start: 0, end: b.len() };
    let stbl = find(b, root, &["moov", "trak", "mdia", "minf", "stbl"]).ok_or("HEIC encode: no sample table.")?;
    let stsd = find(b, stbl, &["stsd"]).ok_or("HEIC encode: no stsd.")?;
    let entry = children(b, stsd.start + 8, stsd.end).into_iter().next().ok_or("HEIC encode: no HEVC track.")?;
    if &entry.ty != b"hvc1" && &entry.ty != b"hev1" {
        return Err("HEIC encode: no HEVC track.".into());
    }
    let hvcc = children(b, entry.start + 78, entry.end).into_iter().find(|x| &x.ty == b"hvcC").ok_or("HEIC encode: no hvcC.")?;
    let hvcc = b[hvcc.start..hvcc.end].to_vec();
    let stsz = find(b, stbl, &["stsz"]).ok_or("HEIC encode: no stsz.")?;
    let fixed = be32(b, stsz.start + 4) as usize;
    let count = be32(b, stsz.start + 8) as usize;
    let sizes: Vec<usize> = (0..count).map(|i| if fixed != 0 { fixed } else { be32(b, stsz.start + 12 + i * 4) as usize }).collect();
    let mut offsets = vec![];
    if let Some(stco) = find(b, stbl, &["stco"]) {
        for i in 0..be32(b, stco.start + 4) as usize {
            offsets.push(be32(b, stco.start + 8 + i * 4) as usize);
        }
    } else if let Some(co64) = find(b, stbl, &["co64"]) {
        for i in 0..be32(b, co64.start + 4) as usize {
            let o = co64.start + 8 + i * 8;
            offsets.push(u64::from_be_bytes(b[o..o + 8].try_into().unwrap()) as usize);
        }
    } else {
        return Err("HEIC encode: no chunk offsets.".into());
    }
    let stsc = find(b, stbl, &["stsc"]).ok_or("HEIC encode: no stsc.")?;
    let runs: Vec<(usize, usize)> = (0..be32(b, stsc.start + 4) as usize).map(|i| (be32(b, stsc.start + 8 + i * 12) as usize, be32(b, stsc.start + 12 + i * 12) as usize)).collect();
    let mut samples = vec![];
    let mut s = 0;
    for (c, &off0) in offsets.iter().enumerate() {
        if s >= count {
            break;
        }
        let per = runs.iter().rev().find(|r| r.0 <= c + 1).map(|r| r.1).unwrap_or(1);
        let mut off = off0;
        for _ in 0..per {
            if s >= count {
                break;
            }
            samples.push(b[off..off + sizes[s]].to_vec());
            off += sizes[s];
            s += 1;
        }
    }
    Ok((hvcc, samples))
}

// ------------------------------------------------------------------ Exif

/// HEIF Exif payload: 4-byte offset to the TIFF header, then the TIFF data, Orientation forced to 1.
fn exif_payload(exif: &[u8]) -> Option<Vec<u8>> {
    let mut tiff = super::image::exif_reset_orientation(exif)?;
    let mut out = vec![0, 0, 0, 0];
    out.append(&mut tiff);
    Some(out)
}

// ------------------------------------------------------------------ HEIF writing

fn bx(ty: &str, parts: &[&[u8]]) -> Vec<u8> {
    let body: Vec<u8> = parts.concat();
    let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(ty.as_bytes());
    v.extend(body);
    v
}

fn full(ty: &str, version: u8, flags: u32, parts: &[&[u8]]) -> Vec<u8> {
    let head = [version, (flags >> 16) as u8, (flags >> 8) as u8, flags as u8];
    let mut all: Vec<&[u8]> = vec![&head];
    all.extend_from_slice(parts);
    bx(ty, &all)
}

fn u16b(v: u32) -> [u8; 2] {
    (v as u16).to_be_bytes()
}
fn u32b(v: u32) -> [u8; 4] {
    v.to_be_bytes()
}

#[allow(clippy::too_many_arguments)]
fn build_heif(hvcc: &[u8], tiles: &[Vec<u8>], tile: u32, cols: u32, rows: u32, width: u32, height: u32, exif: Option<&[u8]>) -> Vec<u8> {
    let grid = 1u32;
    let tile_ids: Vec<u32> = (0..tiles.len() as u32).map(|i| 2 + i).collect();
    let exif_id = exif.map(|_| 2 + tiles.len() as u32);
    let big = width > 0xffff || height > 0xffff;
    let mut grid_data = vec![0u8, big as u8, (rows - 1) as u8, (cols - 1) as u8];
    if big {
        grid_data.extend(u32b(width));
        grid_data.extend(u32b(height));
    } else {
        grid_data.extend(u16b(width));
        grid_data.extend(u16b(height));
    }
    let mut payloads: Vec<(u32, &[u8])> = vec![(grid, &grid_data)];
    if let (Some(id), Some(e)) = (exif_id, exif) {
        payloads.push((id, e));
    }
    for (i, t) in tiles.iter().enumerate() {
        payloads.push((tile_ids[i], t));
    }
    let ftyp = bx("ftyp", &[b"heic", &u32b(0), b"mif1", b"heic", b"miaf"]);
    let make_meta = |mdat_start: u32| -> Vec<u8> {
        let hdlr = full("hdlr", 0, 0, &[&u32b(0), b"pict", &u32b(0), &u32b(0), &u32b(0), &[0]]);
        let pitm = full("pitm", 0, 0, &[&u16b(grid)]);
        let infe = |id: u32, ty: &str, hidden: bool| full("infe", 2, hidden as u32, &[&u16b(id), &u16b(0), ty.as_bytes(), &[0]]);
        let mut infes = vec![infe(grid, "grid", false)];
        infes.extend(tile_ids.iter().map(|&id| infe(id, "hvc1", true)));
        if let Some(id) = exif_id {
            infes.push(infe(id, "Exif", false));
        }
        let n = u16b(infes.len() as u32);
        let mut parts: Vec<&[u8]> = vec![&n];
        parts.extend(infes.iter().map(|v| v.as_slice()));
        let iinf = full("iinf", 0, 0, &parts);
        let mut dimg_body = u16b(grid).to_vec();
        dimg_body.extend(u16b(tile_ids.len() as u32));
        for &id in &tile_ids {
            dimg_body.extend(u16b(id));
        }
        let mut refs = vec![bx("dimg", &[&dimg_body])];
        if let Some(id) = exif_id {
            refs.push(bx("cdsc", &[&u16b(id), &u16b(1), &u16b(grid)]));
        }
        let rp: Vec<&[u8]> = refs.iter().map(|v| v.as_slice()).collect();
        let iref = full("iref", 0, 0, &rp);
        let props = [
            bx("hvcC", &[hvcc]),
            full("ispe", 0, 0, &[&u32b(tile), &u32b(tile)]),
            full("ispe", 0, 0, &[&u32b(width), &u32b(height)]),
            bx("colr", &[b"nclx", &u16b(1), &u16b(13), &u16b(6), &[0x80]]),
            full("pixi", 0, 0, &[&[3, 8, 8, 8]]),
        ];
        let pp: Vec<&[u8]> = props.iter().map(|v| v.as_slice()).collect();
        let ipco = bx("ipco", &pp);
        let assoc = |id: u32, list: &[(u8, bool)]| -> Vec<u8> {
            let mut v = u16b(id).to_vec();
            v.push(list.len() as u8);
            v.extend(list.iter().map(|&(i, ess)| if ess { 0x80 | i } else { i }));
            v
        };
        let mut entries = vec![assoc(grid, &[(3, false), (4, true), (5, false)])];
        entries.extend(tile_ids.iter().map(|&id| assoc(id, &[(1, true), (2, false), (4, true), (5, false)])));
        let cnt = u32b(entries.len() as u32);
        let mut ep: Vec<&[u8]> = vec![&cnt];
        ep.extend(entries.iter().map(|v| v.as_slice()));
        let ipma = full("ipma", 0, 0, &ep);
        let iprp = bx("iprp", &[&ipco, &ipma]);
        let mut off = mdat_start;
        let locs: Vec<Vec<u8>> = payloads
            .iter()
            .map(|(id, data)| {
                let v = [u16b(*id).to_vec(), u16b(0).to_vec(), u16b(1).to_vec(), u32b(off).to_vec(), u32b(data.len() as u32).to_vec()].concat();
                off += data.len() as u32;
                v
            })
            .collect();
        let pc = u16b(payloads.len() as u32);
        let mut lp: Vec<&[u8]> = vec![&[0x44, 0x00], &pc];
        lp.extend(locs.iter().map(|v| v.as_slice()));
        let iloc = full("iloc", 0, 0, &lp);
        full("meta", 0, 0, &[&hdlr, &pitm, &iinf, &iref, &iprp, &iloc])
    };
    let data_len: usize = payloads.iter().map(|(_, d)| d.len()).sum();
    let meta_len = make_meta(0).len();
    let meta = make_meta((ftyp.len() + meta_len + 8) as u32);
    let mut out = Vec::with_capacity(ftyp.len() + meta.len() + 8 + data_len);
    out.extend(&ftyp);
    out.extend(&meta);
    out.extend(u32b((data_len + 8) as u32));
    out.extend(b"mdat");
    for (_, d) in &payloads {
        out.extend_from_slice(d);
    }
    out
}
