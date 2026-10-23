//! Image conversion (convert-image.ts). PNG, JPEG, WebP, GIF, BMP, ICO and TIFF are decoded in-process
//! (the `image` crate), and JPEG, PNG, BMP and PDF are written in-process, so the everyday
//! conversions need no download. ImageMagick (downloaded on first use) decodes HEIC/HEIF, AVIF,
//! SVG and JPEG XL and writes WebP (lossy, like 1.x), TIFF and AVIF; HEIC is written with
//! libx265 through FFmpeg (`heif.rs`).
//!
//! Public: `convert(input, target, ctx)`; phase-1 API kept for tests and watch folders:
//! `supports(ext)` and `image(input, output, target, progress)` (in-process only);
//! `exif_reset_orientation(exif)`.

use super::{ext_of, user, Ctx, Fail, R};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Rgb, RgbImage};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

/// Formats decoded without any engine.
const NATIVE_IN: &[&str] = &["png", "jpg", "jpeg", "jfif", "webp", "gif", "bmp", "ico", "tif", "tiff"];
const WHITE: [u8; 3] = [255, 255, 255];

// ------------------------------------------------------------------ phase-1 API

pub fn supports(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "jfif" | "webp")
}

/// In-process PNG/JPG/WebP conversion into an exact output path (phase 1; watch folders and tests).
pub fn image(input: &Path, output: &Path, target: &str, progress: &dyn Fn(f64)) -> Result<(), String> {
    let d = decode_native(input).map_err(|e| format!("couldn't read the image ({e})"))?;
    progress(0.5);
    let tmp = output.with_extension(format!("{target}.part"));
    let r = (|| -> Result<(), String> {
        let mut w = BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
        match target {
            "jpg" | "jpeg" => write_jpeg(&d, 90, &mut w)?,
            "png" => write_png(&d, &mut w)?,
            // The pure-Rust WebP encoder is lossless only; Convert's lossy WebP goes through ImageMagick.
            "webp" => DynamicImage::ImageRgba8(d.img.to_rgba8()).write_to(&mut w, ImageFormat::WebP).map_err(|e| e.to_string())?,
            other => return Err(format!("can't write {other}")),
        }
        w.flush().map_err(|e| e.to_string())
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, output).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(())
}

// ------------------------------------------------------------------ decoding

pub struct Decoded {
    pub img: DynamicImage,
    pub icc: Option<Vec<u8>>,
    /// Raw TIFF Exif with Orientation already reset to 1 (pixels are upright).
    pub exif: Option<Vec<u8>>,
    /// Extension of the original file.
    pub ext: String,
    /// The file's bytes are a JPEG that can be embedded in a PDF as-is.
    pub jpeg_passthrough: Option<Vec<u8>>,
}

fn decode_native(input: &Path) -> Result<Decoded, String> {
    let ext = ext_of(input);
    let file = std::fs::File::open(input).map_err(|e| e.to_string())?;
    let reader = ImageReader::new(BufReader::new(file)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut dec = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let icc = dec.icc_profile().ok().flatten();
    let exif = dec.exif_metadata().ok().flatten().and_then(|e| exif_reset_orientation(&e));
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    let upright = orientation == image::metadata::Orientation::NoTransforms;
    img.apply_orientation(orientation);
    let mut passthrough = None;
    if matches!(ext.as_str(), "jpg" | "jpeg" | "jfif") && upright && icc.is_none() {
        let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
        if matches!(jpeg_components(&bytes), Some(1) | Some(3)) {
            passthrough = Some(bytes);
        }
    }
    Ok(Decoded { img, icc, exif, ext, jpeg_passthrough: passthrough })
}

/// Number of colour components in a JPEG's frame header (1 grey, 3 YCbCr, 4 CMYK).
fn jpeg_components(b: &[u8]) -> Option<u8> {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let m = b[i + 1];
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            return Some(b[i + 9]);
        }
        i += 2 + len;
    }
    None
}

/// ImageMagick wants a plain name: it expands %d, %x and %[...] in file names.
fn magick_input(input: &Path, ctx: &Ctx) -> R<PathBuf> {
    if input.to_string_lossy().contains('%') {
        let staged = ctx.tmp().join(format!("source.{}", ext_of(input)));
        std::fs::copy(input, &staged)?;
        return Ok(staged);
    }
    Ok(input.to_path_buf())
}

fn magick(ctx: &Ctx, args: Vec<String>) -> R<String> {
    let exe = ctx.engine("magick")?;
    let home = exe.parent().unwrap().to_string_lossy().into_owned();
    let r = ctx.run(&exe.to_string_lossy(), &args, crate::engines::RunOpts { env: vec![("MAGICK_HOME".into(), home)], ..Default::default() })?;
    Ok(r.stdout_text())
}

/// Density that renders an SVG with its long edge at 2048 px or more (SVGs are often tiny icons).
fn svg_density(src: &Path, ctx: &Ctx) -> R<String> {
    let out = magick(ctx, vec!["identify".into(), "-format".into(), "%w %h\n".into(), src.to_string_lossy().into_owned()])?;
    let dims: Vec<f64> = out.split_whitespace().take(2).filter_map(|s| s.parse().ok()).collect();
    let long = dims.iter().cloned().fold(0.0, f64::max);
    let long = if long > 0.0 { long } else { 300.0 };
    Ok(format!("{}", ((72.0 * 2048.0) / long).clamp(72.0, 72.0 * 40.0).round()))
}

/// Decodes anything Convert accepts. Non-native formats go through ImageMagick to a lossless PNG
/// (keeping the ICC profile and 16-bit depth), as 1.x did.
pub fn decode(input: &Path, ctx: &Ctx) -> R<Decoded> {
    let ext = ext_of(input);
    if NATIVE_IN.contains(&ext.as_str()) {
        return decode_native(input).map_err(|e| Fail::Raw(format!("unsupported image format ({e})")));
    }
    let src = magick_input(input, ctx)?;
    let out = ctx.tmp().join("decoded.png");
    let mut a = vec![];
    if ext == "svg" {
        a.extend(["-density".to_string(), svg_density(&src, ctx)?, "-background".into(), "none".into()]);
    }
    a.extend([
        format!("{}[0]", src.display()),
        "-auto-orient".into(),
        "-define".into(),
        "png:compression-level=1".into(),
        "-define".into(),
        "png:compression-filter=0".into(),
        format!("PNG:{}", out.display()),
    ]);
    magick(ctx, a)?;
    let mut d = decode_native(&out).map_err(|e| Fail::Raw(format!("unsupported image format ({e})")))?;
    d.ext = ext;
    Ok(d)
}

// ------------------------------------------------------------------ public

pub fn convert(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let t = match target {
        "jpeg" => "jpg",
        "tif" => "tiff",
        "heif" => "heic",
        x => x,
    };
    if !["jpg", "png", "webp", "heic", "tiff", "avif", "bmp", "pdf"].contains(&t) {
        return user(format!("Can't convert images to {}.", target.to_uppercase()));
    }
    ctx.progress(0.05);
    let mut out = PathBuf::new();
    let r = (|| -> R<()> {
        if matches!(t, "webp" | "tiff" | "avif") {
            out = ctx.out(input, t, "");
            return write_with_magick(input, t, &out, ctx);
        }
        let d = decode(input, ctx)?;
        ctx.check()?;
        ctx.progress(0.25);
        out = ctx.out(input, t, "");
        let q = ctx.prefs().jpg_quality.clamp(1, 100);
        match t {
            "jpg" => write_file(&out, |w| write_jpeg(&d, q, w)),
            "png" => write_file(&out, |w| write_png(&d, w)),
            "bmp" => write_file(&out, |w| write_bmp(&d.img, w)),
            "pdf" => {
                let pdf = image_pdf(&d, q)?;
                std::fs::write(&out, pdf).map_err(Fail::from)
            }
            _ => {
                let rgb = flatten_white(&d.img);
                ctx.progress(0.45);
                let heic = super::heif::encode_heic(rgb.as_raw(), rgb.width(), rgb.height(), q, d.exif.as_deref(), ctx)?;
                std::fs::write(&out, heic).map_err(Fail::from)
            }
        }
    })();
    if let Err(e) = r {
        if !out.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&out);
        }
        if let Fail::Raw(m) = &e {
            let l = m.to_lowercase();
            if ["unsupported image format", "corrupt", "premature end", "bad seek", "insufficient image data", "improper image header", "no decode delegate", "negative or zero image size"].iter().any(|n| l.contains(n)) {
                return user("This image can't be read. It may be damaged or in an unusual format.");
            }
        }
        return Err(e);
    }
    ctx.progress(1.0);
    Ok(vec![out])
}

fn write_file(out: &Path, f: impl FnOnce(&mut BufWriter<std::fs::File>) -> Result<(), String>) -> R<()> {
    let mut w = BufWriter::new(std::fs::File::create(out)?);
    f(&mut w).map_err(Fail::Raw)?;
    w.flush()?;
    Ok(())
}

/// WebP (lossy, animation kept), TIFF (LZW) and AVIF straight from the source with ImageMagick,
/// which keeps the ICC profile and Exif.
fn write_with_magick(input: &Path, t: &str, out: &Path, ctx: &Ctx) -> R<()> {
    let ext = ext_of(input);
    let q = ctx.prefs().jpg_quality.clamp(1, 100);
    let src = magick_input(input, ctx)?;
    let mut a: Vec<String> = vec![];
    if ext == "svg" {
        a.extend(["-density".into(), svg_density(&src, ctx)?, "-background".into(), "none".into()]);
    }
    let animated = t == "webp" && matches!(ext.as_str(), "gif" | "webp");
    a.push(if animated { src.to_string_lossy().into_owned() } else { format!("{}[{}]", src.display(), if ext == "ico" { largest_frame(&src, ctx) } else { 0 }) });
    if animated && ext == "gif" {
        a.push("-coalesce".into());
    }
    a.push("-auto-orient".into());
    match t {
        "webp" => a.extend(super::args(&["-quality", &q.to_string(), "-define", "webp:alpha-quality=100", "-define", "webp:method=4"])),
        "tiff" => a.extend(super::args(&["-compress", "LZW", "-define", "tiff:predictor=2"])),
        _ => {
            // AVIF's quality scale runs lower than JPEG's for the same visual result.
            a.extend(super::args(&["-quality", &(q as i64 - 25).clamp(30, 90).to_string()]));
            if q >= 95 {
                a.extend(super::args(&["-define", "heic:chroma=444"]));
            }
        }
    }
    ctx.progress(0.3);
    a.push(format!("{}:{}", t.to_uppercase(), out.display()));
    magick(ctx, a)?;
    if std::fs::metadata(out).map(|m| m.len() == 0).unwrap_or(true) {
        return Err(Fail::Raw("ImageMagick produced no output.".into()));
    }
    Ok(())
}

fn largest_frame(src: &Path, ctx: &Ctx) -> usize {
    let Ok(out) = magick(ctx, vec!["identify".into(), "-format".into(), "%p %w %h\n".into(), src.to_string_lossy().into_owned()]) else { return 0 };
    let mut best = (0, -1i64);
    for l in out.lines() {
        let v: Vec<i64> = l.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() == 3 && v[1] * v[2] > best.1 {
            best = (v[0] as usize, v[1] * v[2]);
        }
    }
    best.0
}

// ------------------------------------------------------------------ writers

/// JPEG has no alpha: transparent pixels are laid over white.
pub fn flatten_white(img: &DynamicImage) -> RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = p[3] as u32;
        let mix = |c: u8, bg: u8| ((c as u32 * a + bg as u32 * (255 - a) + 127) / 255) as u8;
        *o = Rgb([mix(p[0], WHITE[0]), mix(p[1], WHITE[1]), mix(p[2], WHITE[2])]);
    }
    out
}

fn write_jpeg(d: &Decoded, q: u32, w: &mut dyn Write) -> Result<(), String> {
    let rgb = flatten_white(&d.img);
    let mut enc = JpegEncoder::new_with_quality(w, q.clamp(1, 100) as u8);
    if let Some(icc) = &d.icc {
        let _ = enc.set_icc_profile(icc.clone());
    }
    if let Some(e) = &d.exif {
        let _ = enc.set_exif_metadata(e.clone());
    }
    enc.write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())
}

fn write_png(d: &Decoded, w: &mut dyn Write) -> Result<(), String> {
    let mut enc = PngEncoder::new_with_quality(w, image::codecs::png::CompressionType::Default, image::codecs::png::FilterType::Adaptive);
    if let Some(icc) = &d.icc {
        let _ = enc.set_icc_profile(icc.clone());
    }
    if let Some(e) = &d.exif {
        let _ = enc.set_exif_metadata(e.clone());
    }
    let img = match &d.img {
        DynamicImage::ImageLuma8(_) | DynamicImage::ImageLumaA8(_) | DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) | DynamicImage::ImageLuma16(_) | DynamicImage::ImageLumaA16(_) | DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_) => d.img.clone(),
        other => DynamicImage::ImageRgba16(other.to_rgba16()),
    };
    enc.write_image(img.as_bytes(), img.width(), img.height(), img.color().into()).map_err(|e| e.to_string())
}

/// 24-bit BMP (BITMAPINFOHEADER, bottom-up), flattened onto white.
fn write_bmp(img: &DynamicImage, w: &mut dyn Write) -> Result<(), String> {
    let rgb = flatten_white(img);
    let (wd, ht) = (rgb.width() as usize, rgb.height() as usize);
    let stride = (wd * 3).div_ceil(4) * 4;
    let size = 54 + stride * ht;
    if size > u32::MAX as usize {
        return Err("This image is too large for BMP.".into());
    }
    let mut buf = vec![0u8; size];
    buf[0..2].copy_from_slice(b"BM");
    buf[2..6].copy_from_slice(&(size as u32).to_le_bytes());
    buf[10..14].copy_from_slice(&54u32.to_le_bytes());
    buf[14..18].copy_from_slice(&40u32.to_le_bytes());
    buf[18..22].copy_from_slice(&(wd as i32).to_le_bytes());
    buf[22..26].copy_from_slice(&(ht as i32).to_le_bytes());
    buf[26..28].copy_from_slice(&1u16.to_le_bytes());
    buf[28..30].copy_from_slice(&24u16.to_le_bytes());
    buf[34..38].copy_from_slice(&((stride * ht) as u32).to_le_bytes());
    buf[38..42].copy_from_slice(&2835i32.to_le_bytes()); // 72 dpi
    buf[42..46].copy_from_slice(&2835i32.to_le_bytes());
    let raw = rgb.as_raw();
    for y in 0..ht {
        let row = 54 + (ht - 1 - y) * stride;
        for x in 0..wd {
            let s = (y * wd + x) * 3;
            let d = row + x * 3;
            buf[d] = raw[s + 2];
            buf[d + 1] = raw[s + 1];
            buf[d + 2] = raw[s];
        }
    }
    w.write_all(&buf).map_err(|e| e.to_string())
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(6));
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

/// One page sized to the image (72 dpi), scaled down to A4 if it would be huge.
pub fn image_pdf(d: &Decoded, q: u32) -> R<Vec<u8>> {
    let (wpx, hpx) = (d.img.width(), d.img.height());
    let photo = ["jpg", "jpeg", "jfif", "heic", "heif", "avif", "webp"].contains(&d.ext.as_str());
    let alpha = d.img.color().has_alpha();
    // (image dict, data, optional smask (dict, data))
    let (dict, data, smask): (String, Vec<u8>, Option<(String, Vec<u8>)>) = if let Some(jpg) = &d.jpeg_passthrough {
        let cs = if jpeg_components(jpg) == Some(1) { "DeviceGray" } else { "DeviceRGB" };
        (format!("/ColorSpace/{cs}/BitsPerComponent 8/Filter/DCTDecode"), jpg.clone(), None)
    } else if photo && !alpha {
        let mut buf = Vec::new();
        let rgb = d.img.to_rgb8();
        JpegEncoder::new_with_quality(&mut buf, q.max(85) as u8).write_image(rgb.as_raw(), wpx, hpx, image::ExtendedColorType::Rgb8).map_err(|e| Fail::Raw(e.to_string()))?;
        ("/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode".into(), buf, None)
    } else {
        let rgba = d.img.to_rgba8();
        let rgb: Vec<u8> = rgba.pixels().flat_map(|p| [p[0], p[1], p[2]]).collect();
        let sm = alpha.then(|| {
            let a: Vec<u8> = rgba.pixels().map(|p| p[3]).collect();
            (format!("/Type/XObject/Subtype/Image/Width {wpx}/Height {hpx}/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode"), deflate(&a))
        });
        ("/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode".into(), deflate(&rgb), sm)
    };
    let (mut w, mut h) = (wpx as f64, hpx as f64);
    let long = w.max(h);
    if long > 1190.0 {
        // Fit the long edge to A4 so it prints sensibly.
        let k = 842.0 / long;
        w *= k;
        h *= k;
    }
    let mut pdf = PdfWriter::new();
    let img_id = 4;
    let smask_ref = if smask.is_some() { "/SMask 6 0 R".to_string() } else { String::new() };
    pdf.obj(1, b"<</Type/Catalog/Pages 2 0 R>>".to_vec());
    pdf.obj(2, b"<</Type/Pages/Kids[3 0 R]/Count 1>>".to_vec());
    pdf.obj(3, format!("<</Type/Page/Parent 2 0 R/MediaBox[0 0 {w:.3} {h:.3}]/Resources<</XObject<</Im0 {img_id} 0 R>>>>/Contents 5 0 R>>").into_bytes());
    pdf.stream(img_id, &format!("/Type/XObject/Subtype/Image/Width {wpx}/Height {hpx}{dict}{smask_ref}"), &data);
    pdf.stream(5, "", format!("q {w:.3} 0 0 {h:.3} 0 0 cm /Im0 Do Q").as_bytes());
    if let Some((sd, sdata)) = smask {
        pdf.stream(6, &sd, &sdata);
    }
    Ok(pdf.finish())
}

/// A tiny PDF serializer: numbered objects, then xref and trailer (with Producer "Orange").
pub struct PdfWriter {
    buf: Vec<u8>,
    offsets: Vec<(u32, usize)>,
}

impl Default for PdfWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfWriter {
    pub fn new() -> Self {
        PdfWriter { buf: b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec(), offsets: vec![] }
    }
    pub fn obj(&mut self, id: u32, body: Vec<u8>) {
        self.offsets.push((id, self.buf.len()));
        self.buf.extend(format!("{id} 0 obj\n").as_bytes());
        self.buf.extend(body);
        self.buf.extend(b"\nendobj\n");
    }
    pub fn stream(&mut self, id: u32, dict: &str, data: &[u8]) {
        let mut b = format!("<<{dict}/Length {}>>\nstream\n", data.len()).into_bytes();
        b.extend_from_slice(data);
        b.extend(b"\nendstream");
        self.obj(id, b);
    }
    pub fn finish(mut self) -> Vec<u8> {
        let info = self.offsets.iter().map(|o| o.0).max().unwrap_or(0) + 1;
        self.obj(info, b"<</Producer(Orange)/Creator(Orange)>>".to_vec());
        self.offsets.sort();
        let xref = self.buf.len();
        let n = info + 1;
        let mut x = format!("xref\n0 {n}\n0000000000 65535 f \n");
        let mut k = 0;
        for id in 1..n {
            if k < self.offsets.len() && self.offsets[k].0 == id {
                x.push_str(&format!("{:010} 00000 n \n", self.offsets[k].1));
                k += 1;
            } else {
                x.push_str("0000000000 65535 f \n");
            }
        }
        x.push_str(&format!("trailer\n<</Size {n}/Root 1 0 R/Info {info} 0 R>>\nstartxref\n{xref}\n%%EOF\n"));
        self.buf.extend(x.as_bytes());
        self.buf
    }
}

// ------------------------------------------------------------------ Exif

/// Raw Exif ("Exif\0\0" + TIFF, or TIFF) to TIFF with Orientation set to 1. None when malformed.
pub fn exif_reset_orientation(exif: &[u8]) -> Option<Vec<u8>> {
    let mut t = exif;
    if let Some(i) = exif.windows(6).take(16).position(|w| w == b"Exif\0\0") {
        t = &exif[i + 6..];
    }
    if t.len() < 8 {
        return None;
    }
    let le = &t[0..2] == b"II";
    if !le && &t[0..2] != b"MM" {
        return None;
    }
    let mut tiff = t.to_vec();
    let u16_ = |b: &[u8], o: usize| -> Option<u16> {
        let s = b.get(o..o + 2)?;
        Some(if le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) })
    };
    let s = tiff.get(4..8)?;
    let ifd = if le { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) } as usize;
    let n = u16_(&tiff, ifd)? as usize;
    for k in 0..n {
        let e = ifd + 2 + k * 12;
        if u16_(&tiff, e)? == 0x0112 {
            let v = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            tiff.get_mut(e + 8..e + 10)?.copy_from_slice(&v);
        }
    }
    Some(tiff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::testutil;

    #[test]
    fn png_with_alpha_to_jpg_bmp_pdf() {
        let dir = testutil::dir("img");
        let src = dir.join("a.png");
        let mut img = image::RgbaImage::new(4, 3);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.save(&src).unwrap();
        let c = testutil::ctx();
        let out = convert(&src, "jpg", &c).unwrap();
        let back = image::open(&out[0]).unwrap().to_rgb8();
        assert_eq!(back.dimensions(), (4, 3));
        assert!(back.get_pixel(3, 2).0.iter().all(|&v| v > 240));
        let bmp = convert(&src, "bmp", &c).unwrap();
        assert_eq!(image::open(&bmp[0]).unwrap().to_rgb8().get_pixel(0, 0).0, [255, 0, 0]);
        let pdf = convert(&src, "pdf", &c).unwrap();
        let bytes = std::fs::read(&pdf[0]).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.7") && bytes.ends_with(b"%%EOF\n"));
        drop(c);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_api_still_works() {
        let dir = testutil::dir("img1");
        let src = dir.join("a.png");
        image::RgbImage::new(2, 2).save(&src).unwrap();
        image(&src, &dir.join("a.jpg"), "jpg", &|_| {}).unwrap();
        assert!(dir.join("a.jpg").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
