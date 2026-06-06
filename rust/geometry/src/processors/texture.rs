// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC surface-texture resolution (issue #961).
//!
//! Decodes `IfcBlobTexture` (embedded PNG) and `IfcPixelTexture` (raw pixels)
//! to RGBA8, and resolves `IfcIndexedTriangleTextureMap` per-triangle texture
//! coordinates aligned with the tessellated face set. All texture logic lives
//! in Rust so the server, CLI, SDK and the browser (wasm) path share one
//! implementation — no Rust/TS drift. The browser layer only uploads the
//! decoded RGBA to a GPU texture; it performs no IFC or image decoding.
//!
//! `IfcImageTexture` (external URL) is intentionally out of scope here — it
//! needs an async fetch resolver outside the geometry pipeline; tracked as a
//! follow-up.

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;

/// A decoded RGBA8 image ready for GPU upload.
#[derive(Debug, Clone)]
pub struct MeshTexture {
    /// `width * height * 4` bytes, row-major, top-down, straight alpha.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// `IfcSurfaceTexture.RepeatS/RepeatT` → sampler wrap (repeat vs clamp).
    pub repeat_s: bool,
    pub repeat_t: bool,
}

/// A fully resolved `IfcIndexedTriangleTextureMap` for one face set.
#[derive(Debug, Clone)]
pub struct ResolvedTextureMap {
    pub texture: MeshTexture,
    /// `IfcTextureVertexList.TexCoordsList` as `[u, v]` (0-based storage).
    pub tex_coords: Vec<[f32; 2]>,
    /// `TexCoordIndex`: per-triangle 1-based indices into `tex_coords`,
    /// parallel to the face set's `CoordIndex`.
    pub tex_coord_index: Vec<[u32; 3]>,
}

// NOTE: `IfcSurfaceTexture.TextureTransform` (IfcCartesianTransformationOperator2D)
// is intentionally NOT applied. The authored `IfcTextureVertexList` coordinates
// already map the image as intended (the buildingSMART annex-E reference renders
// them ~1:1); applying the operator's Scale (e.g. 48 in the blob fixture)
// over-tiles the texture into noise. If a future file genuinely needs a UV
// rotation/offset we can revisit, but no test fixture requires it.

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

/// Decode a PNG byte buffer to RGBA8. Returns `(rgba, width, height)`.
fn decode_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut decoder = png::Decoder::new(bytes);
    // EXPAND: palette → RGB, sub-8-bit grayscale → 8-bit, tRNS → alpha.
    // STRIP_16: 16-bit channels → 8-bit. Leaves Rgb/Rgba/Grayscale/GA at 8-bit.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
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
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
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
fn decode_raster_image(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
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

/// Decode `IfcBlobTexture` → RGBA8. Attributes (IFC4):
/// RepeatS(0), RepeatT(1), Mode(2), TextureTransform(3), Parameter(4),
/// RasterFormat(5), RasterCode(6).
fn decode_blob_texture(entity: &DecodedEntity) -> Option<MeshTexture> {
    let raster_code = entity.get(6).and_then(|a| a.as_string())?;
    let bytes = decode_step_binary(raster_code);
    if bytes.len() < 8 {
        return None;
    }
    // Dispatch on the image's magic bytes (PNG or JPEG) rather than trusting the
    // RasterFormat string spelling ('PNG' / 'JPG' / 'JPEG' all occur).
    let (rgba, width, height) = decode_raster_image(&bytes)?;
    Some(MeshTexture {
        rgba,
        width,
        height,
        repeat_s: read_bool(entity, 0).unwrap_or(true),
        repeat_t: read_bool(entity, 1).unwrap_or(true),
    })
}

/// Decode `IfcPixelTexture` → RGBA8. Attributes (IFC4):
/// RepeatS(0), RepeatT(1), Mode(2), TextureTransform(3), Parameter(4),
/// Width(5), Height(6), ColourComponents(7), Pixel(8 = list of BINARY).
fn decode_pixel_texture(entity: &DecodedEntity) -> Option<MeshTexture> {
    let width = entity.get(5).and_then(|a| a.as_int())? as u32;
    let height = entity.get(6).and_then(|a| a.as_int())? as u32;
    let components = entity.get(7).and_then(|a| a.as_int())? as usize;
    if width == 0 || height == 0 || !(1..=4).contains(&components) {
        return None;
    }
    let pixels = entity.get(8).and_then(|a| a.as_list())?;
    let expected = (width as usize) * (height as usize);
    let mut rgba = Vec::with_capacity(expected * 4);
    for px in pixels.iter() {
        let s = px.as_string()?;
        let comp = decode_step_binary(s);
        if comp.len() < components {
            return None;
        }
        // Expand 1..=4 colour components to RGBA8.
        let (r, g, b, a) = match components {
            1 => (comp[0], comp[0], comp[0], 255),
            2 => (comp[0], comp[0], comp[0], comp[1]),
            3 => (comp[0], comp[1], comp[2], 255),
            _ => (comp[0], comp[1], comp[2], comp[3]),
        };
        rgba.extend_from_slice(&[r, g, b, a]);
    }
    if rgba.len() != expected * 4 {
        return None;
    }
    Some(MeshTexture {
        rgba,
        width,
        height,
        repeat_s: read_bool(entity, 0).unwrap_or(true),
        repeat_t: read_bool(entity, 1).unwrap_or(true),
    })
}

fn read_bool(entity: &DecodedEntity, idx: usize) -> Option<bool> {
    entity.get(idx).and_then(|a| a.as_enum()).map(|v| v == "T")
}

/// Resolve an `IfcSurfaceTexture` subtype reference to a decoded image.
fn resolve_surface_texture(texture_id: u32, decoder: &mut EntityDecoder) -> Option<MeshTexture> {
    let entity = decoder.decode_by_id(texture_id).ok()?;
    match entity.ifc_type {
        IfcType::IfcBlobTexture => decode_blob_texture(&entity),
        IfcType::IfcPixelTexture => decode_pixel_texture(&entity),
        // IfcImageTexture (URL) deferred — needs async fetch outside the kernel.
        _ => None,
    }
}

/// Resolve a single `IfcIndexedTriangleTextureMap` entity into a
/// [`ResolvedTextureMap`] keyed by the face set it maps to.
/// Attributes: Maps(0 = list of IfcSurfaceTexture), MappedTo(1 = face set),
/// TexCoords(2 = IfcTextureVertexList), TexCoordIndex(3 = list of 3 ints).
fn resolve_triangle_texture_map(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<(u32, ResolvedTextureMap)> {
    let face_set_id = entity.get_ref(1)?;

    // Maps[0] → surface texture.
    let maps = entity.get(0)?.as_list()?;
    let texture_id = maps.iter().find_map(|m| m.as_entity_ref())?;
    let texture = resolve_surface_texture(texture_id, decoder)?;

    // TexCoords → IfcTextureVertexList.TexCoordsList (attr 0).
    let tvl_id = entity.get_ref(2)?;
    let tvl = decoder.decode_by_id(tvl_id).ok()?;
    let coord_list = tvl.get(0)?.as_list()?;
    let tex_coords: Vec<[f32; 2]> = coord_list
        .iter()
        .filter_map(|c| {
            let uv = c.as_list()?;
            let u = uv.first().and_then(|v| v.as_float())? as f32;
            let v = uv.get(1).and_then(|v| v.as_float())? as f32;
            Some([u, v])
        })
        .collect();
    if tex_coords.is_empty() {
        return None;
    }

    // TexCoordIndex (attr 3) → per-triangle [i, j, k].
    let index_attr = entity.get(3)?.as_list()?;
    let tex_coord_index: Vec<[u32; 3]> = index_attr
        .iter()
        .filter_map(|tri| {
            let t = tri.as_list()?;
            let a = t.first().and_then(|v| v.as_int())? as u32;
            let b = t.get(1).and_then(|v| v.as_int())? as u32;
            let c = t.get(2).and_then(|v| v.as_int())? as u32;
            Some([a, b, c])
        })
        .collect();
    if tex_coord_index.is_empty() {
        return None;
    }

    Some((
        face_set_id,
        ResolvedTextureMap {
            texture,
            tex_coords,
            tex_coord_index,
        },
    ))
}

/// Scan the model for `IfcIndexedTriangleTextureMap` entities and build an index
/// keyed by the face set id each one maps to (issue #961). Cheap substring
/// bail-out keeps untextured files (the overwhelming majority) off the scan.
pub fn build_texture_index(
    content: &str,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, ResolvedTextureMap> {
    let mut index = FxHashMap::default();
    if !content.contains("IFCINDEXEDTRIANGLETEXTUREMAP") {
        return index;
    }
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCINDEXEDTRIANGLETEXTUREMAP" {
            continue;
        }
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some((face_set_id, resolved)) = resolve_triangle_texture_map(&entity, decoder) {
                index.entry(face_set_id).or_insert(resolved);
            }
        }
    }
    index
}
