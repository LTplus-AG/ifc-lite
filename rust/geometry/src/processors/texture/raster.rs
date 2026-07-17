// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raster decoding for IFC surface textures (#961): STEP `BINARY` literals
//! plus PNG/JPEG → RGBA8, with hostile-header dimension bounds. Split from the
//! entity-resolution half (`texture`) so each stays within the module-size
//! house rule; no behaviour differences.

/// Decode a STEP binary literal as surfaced by the decoder (the parser strips
/// the surrounding double quotes; the first hex character is the count of
/// unused leading bits — `0` for the byte-aligned data every IFC texture
/// fixture uses). Strips that leading character and hex-decodes the remainder
/// pairwise. Returns the raw bytes (e.g. a complete PNG file for a blob, or one
/// pixel's colour components for a pixel literal).
pub fn decode_step_binary(s: &str) -> Vec<u8> {
    let s = s.trim().trim_matches('"');
    if s.len() < 3 {
        return Vec::new();
    }
    let hex = s.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    // Skip index 0 (the unused-bits indicator); decode the rest in pairs.
    let mut i = 1;
    while i + 1 < hex.len() {
        match (hex_val(hex[i]), hex_val(hex[i + 1])) {
            (Some(h), Some(l)) => out.push((h << 4) | l),
            _ => break,
        }
        i += 2;
    }
    out
}

#[inline]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Upper bound on a decoded texture's width/height. 16384² RGBA ≈ 1 GiB — a
/// hostile/garbage image header claiming larger dimensions is rejected BEFORE
/// any pixel buffer is allocated, so a crafted file can't drive an OOM. Matches
/// the `IfcPixelTexture` bound.
pub(super) const MAX_TEX_DIM: u32 = 16384;

/// Decode a PNG byte buffer to RGBA8. Returns `(rgba, width, height)`.
fn decode_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    // png 0.18 requires the reader to be `BufRead + Seek`. `&[u8]` is `BufRead`
    // but not `Seek`, so wrap it in a `Cursor`, which satisfies both.
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // EXPAND: palette → RGB, sub-8-bit grayscale → 8-bit, tRNS → alpha.
    // STRIP_16: 16-bit channels → 8-bit. Leaves Rgb/Rgba/Grayscale/GA at 8-bit.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    // Reject an oversized header before `output_buffer_size()` allocates.
    let png_info = reader.info();
    if png_info.width == 0
        || png_info.height == 0
        || png_info.width > MAX_TEX_DIM
        || png_info.height > MAX_TEX_DIM
    {
        return None;
    }
    // png 0.18 returns Option here (None on size overflow); propagate as a decode failure.
    let mut buf = vec![0u8; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width, info.height);
    let px = (w as usize) * (h as usize);
    let src = &buf[..info.buffer_size()];
    let mut rgba = Vec::with_capacity(px * 4);
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(&src[..px * 4]),
        png::ColorType::Rgb => {
            for c in src.chunks_exact(3) {
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in src.iter() {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for c in src.chunks_exact(2) {
                rgba.extend_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
        }
        // EXPAND should have removed Indexed; bail if a decoder ever leaves it.
        png::ColorType::Indexed => return None,
    }
    if rgba.len() != px * 4 {
        return None;
    }
    Some((rgba, w, h))
}

/// Decode a JPEG byte buffer to RGBA8. Returns `(rgba, width, height)`.
fn decode_jpeg(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    // Read just the headers first so an oversized image is rejected before the
    // full `decode()` allocates its pixel buffer.
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    if info.width == 0
        || info.height == 0
        || info.width as u32 > MAX_TEX_DIM
        || info.height as u32 > MAX_TEX_DIM
    {
        return None;
    }
    let pixels = decoder.decode().ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let px = w * h;
    let mut rgba = Vec::with_capacity(px * 4);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            for c in pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        jpeg_decoder::PixelFormat::L8 => {
            for &g in pixels.iter() {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
        }
        // L16 / CMYK32 are rare for IFC textures; bail to the white fallback.
        _ => return None,
    }
    if rgba.len() != px * 4 {
        return None;
    }
    Some((rgba, w as u32, h as u32))
}

/// Decode raster image bytes to RGBA8 by sniffing the magic bytes (PNG or
/// JPEG), so any `RasterFormat` string spelling resolves correctly.
pub(super) fn decode_raster_image(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() >= 8 && bytes[..8] == PNG_MAGIC {
        return decode_png(bytes);
    }
    // JPEG: starts with FF D8 FF.
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return decode_jpeg(bytes);
    }
    None
}
