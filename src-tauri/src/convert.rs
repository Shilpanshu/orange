//! In-process image conversion (PNG / JPG / WebP) with the `image` crate. Formats beyond these
//! will go through downloaded engines (FFmpeg, libvips, ...) in phase 2.

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, ImageReader, Rgb, RgbImage};
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

pub fn supports(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "jfif" | "webp")
}

/// JPEG has no alpha: transparent pixels are laid over white, as Orange 1.x does.
fn flatten_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        *o = Rgb([mix(p[0]), mix(p[1]), mix(p[2])]);
    }
    out
}

pub fn image(input: &Path, output: &Path, target: &str, progress: &dyn Fn(f64)) -> Result<(), String> {
    let reader = ImageReader::new(BufReader::new(File::open(input).map_err(|e| e.to_string())?))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let img = reader.decode().map_err(|e| format!("couldn't read the image ({e})"))?;
    progress(0.5);
    // Write to a temporary name, then rename, so a failed or cancelled run leaves no half file.
    let tmp = output.with_extension(format!("{target}.part"));
    let result = (|| -> Result<(), String> {
        let mut w = BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        match target {
            "jpg" | "jpeg" => {
                let rgb = if img.color().has_alpha() { flatten_white(&img) } else { img.to_rgb8() };
                JpegEncoder::new_with_quality(&mut w, 90).encode_image(&rgb).map_err(|e| e.to_string())?;
            }
            "png" => img.write_to(&mut w, ImageFormat::Png).map_err(|e| e.to_string())?,
            // The pure-Rust WebP encoder is lossless only; lossy WebP comes with libwebp/libvips.
            "webp" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(&mut w, ImageFormat::WebP).map_err(|e| e.to_string())?,
            other => return Err(format!("can't write {other}")),
        }
        w.flush().map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, output).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_with_alpha_to_jpg_flattens_on_white() {
        let dir = std::env::temp_dir().join(format!("orange-convert-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.png");
        let mut img = image::RgbaImage::new(4, 4);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.save(&src).unwrap();
        let out = dir.join("a.jpg");
        image(&src, &out, "jpg", &|_| {}).unwrap();
        let back = image::open(&out).unwrap().to_rgb8();
        assert_eq!(back.dimensions(), (4, 4));
        // A fully transparent pixel became (near) white.
        assert!(back.get_pixel(3, 3).0.iter().all(|&c| c > 240));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
