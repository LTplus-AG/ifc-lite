// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC surface-texture resolution (issues #961, #1781).
//!
//! Decodes `IfcBlobTexture` (embedded PNG) and `IfcPixelTexture` (raw pixels)
//! to RGBA8, and resolves `IfcIndexedTriangleTextureMap` per-triangle texture
//! coordinates aligned with the tessellated face set. All texture logic lives
//! in Rust so the server, CLI, SDK and the browser (wasm) path share one
//! implementation — no Rust/TS drift. The browser layer only uploads the
//! decoded RGBA to a GPU texture; it performs no IFC or image decoding.
//!
//! `IfcImageTexture` (#1781) resolves to an [`ImageTextureRef`] — the
//! `URLReference` plus repeat flags — NOT decoded pixels: the image bytes live
//! outside the model (typically a sibling file inside the `.ifcZIP` container),
//! and the real-world files reference multi-megapixel JPEGs shared by dozens of
//! face sets, so shipping decoded RGBA through every worker/mesh would multiply
//! hundreds of MB. The host layer (browser: `createImageBitmap` on the zip
//! sibling; native consumers: the file next to the .ifc) resolves the reference
//! ONCE per `texture_id` and shares the GPU upload.

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};

mod raster;
pub use raster::decode_step_binary;
use raster::{decode_raster_image, MAX_TEX_DIM};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// A decoded RGBA8 image ready for GPU upload.
#[derive(Debug, Clone)]
pub struct MeshTexture {
    /// `width * height * 4` bytes, row-major, top-down, straight alpha.
    /// `Arc`-shared so every mesh/attachment referencing this texture reuses
    /// ONE pixel allocation (#1781 — real files share a multi-megapixel image
    /// across dozens of face sets).
    pub rgba: std::sync::Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    /// `IfcSurfaceTexture.RepeatS/RepeatT` → sampler wrap (repeat vs clamp).
    pub repeat_s: bool,
    pub repeat_t: bool,
}

/// Where a resolved surface texture's pixels come from.
#[derive(Debug, Clone)]
pub enum TextureSource {
    /// Decoded RGBA8 (`IfcBlobTexture` / `IfcPixelTexture`), shared via `Arc`
    /// across every face set that maps the same texture entity.
    Decoded(Arc<MeshTexture>),
    /// `IfcImageTexture` (#1781): an external image reference the host layer
    /// resolves (e.g. a sibling file inside the `.ifcZIP` container).
    Image(ImageTextureRef),
}

/// An unresolved `IfcImageTexture` reference (#1781).
#[derive(Debug, Clone)]
pub struct ImageTextureRef {
    /// `IfcImageTexture.URLReference` verbatim (usually a relative filename).
    pub url: String,
    pub repeat_s: bool,
    pub repeat_t: bool,
}

/// A surface texture attached to an output mesh: the stable dedup key plus the
/// pixel source. `texture_id` is the `IfcSurfaceTexture` express id — every
/// mesh sampling the same image carries the same id, so consumers create one
/// GPU texture per id instead of one per mesh.
#[derive(Debug, Clone)]
pub struct TextureAttachment {
    pub texture_id: u32,
    pub source: TextureSource,
}

/// A fully resolved `IfcIndexedTriangleTextureMap` for one face set.
#[derive(Debug, Clone)]
pub struct ResolvedTextureMap {
    /// Express id of the source `IfcSurfaceTexture` (dedup key).
    pub texture_id: u32,
    pub texture: TextureSource,
    /// `IfcTextureVertexList.TexCoordsList` as `[u, v]` (0-based storage).
    pub tex_coords: Vec<[f32; 2]>,
    /// `TexCoordIndex`: per-triangle 1-based indices into `tex_coords`,
    /// parallel to the face set's `CoordIndex`. `None` when the attribute is
    /// `$` — the spec default, meaning texture vertices pair 1:1 with the face
    /// set's `Coordinates`, so its `CoordIndex` doubles as the UV index (the
    /// SketchUp IFC Manager export path authors exactly this shape, #1781).
    pub tex_coord_index: Option<Vec<[u32; 3]>>,
}

impl ResolvedTextureMap {
    /// The attachment consumers stamp on meshes produced from this map.
    pub fn attachment(&self) -> TextureAttachment {
        TextureAttachment {
            texture_id: self.texture_id,
            source: self.texture.clone(),
        }
    }
}

// NOTE: `IfcSurfaceTexture.TextureTransform` (IfcCartesianTransformationOperator2D)
// is intentionally NOT applied. The authored `IfcTextureVertexList` coordinates
// already map the image as intended (the buildingSMART annex-E reference renders
// them ~1:1); applying the operator's Scale (e.g. 48 in the blob fixture)
// over-tiles the texture into noise. If a future file genuinely needs a UV
// rotation/offset we can revisit, but no test fixture requires it.

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
        rgba: Arc::new(rgba),
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
    // Validate the signed values BEFORE casting — a malformed `-1` would become
    // u32::MAX and try to reserve absurd memory. Bound the dimensions
    // (16384² RGBA ≈ 1 GiB) so a hostile/garbage file is rejected cleanly.
    let width = entity.get(5).and_then(|a| a.as_int())?;
    let height = entity.get(6).and_then(|a| a.as_int())?;
    let components = entity.get(7).and_then(|a| a.as_int())?;
    let max_dim = MAX_TEX_DIM as i64;
    if width <= 0
        || height <= 0
        || width > max_dim
        || height > max_dim
        || !(1..=4).contains(&components)
    {
        return None;
    }
    let width = width as u32;
    let height = height as u32;
    let components = components as usize;
    let pixels = entity.get(8).and_then(|a| a.as_list())?;
    let expected = (width as usize) * (height as usize);
    // Reject a cardinality mismatch BEFORE decoding: a hostile file declaring
    // tiny dimensions but carrying a huge Pixel list would otherwise decode
    // (and allocate) the whole list just to fail the length check at the end.
    if pixels.len() != expected {
        return None;
    }
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
        rgba: Arc::new(rgba),
        width,
        height,
        repeat_s: read_bool(entity, 0).unwrap_or(true),
        repeat_t: read_bool(entity, 1).unwrap_or(true),
    })
}

fn read_bool(entity: &DecodedEntity, idx: usize) -> Option<bool> {
    entity.get(idx).and_then(|a| a.as_enum()).map(|v| v == "T")
}

/// Read `IfcImageTexture` → an [`ImageTextureRef`] (#1781). Attributes (IFC4):
/// RepeatS(0), RepeatT(1), Mode(2), TextureTransform(3), Parameter(4),
/// URLReference(5). The URL is carried verbatim for the host layer to resolve;
/// `TextureTransform` is intentionally ignored like the other subtypes (see the
/// NOTE above `decode_step_binary`).
fn read_image_texture(entity: &DecodedEntity) -> Option<ImageTextureRef> {
    let url = entity.get(5).and_then(|a| a.as_string())?.trim().to_string();
    if url.is_empty() {
        return None;
    }
    Some(ImageTextureRef {
        url,
        repeat_s: read_bool(entity, 0).unwrap_or(true),
        repeat_t: read_bool(entity, 1).unwrap_or(true),
    })
}

/// Resolve an `IfcSurfaceTexture` subtype reference to a pixel source. Decoded
/// results are cached per `build_texture_index` run: real files map ONE texture
/// entity from dozens of `IfcIndexedTriangleTextureMap`s (one per face set), so
/// without the cache the same image would decode once per face set.
fn resolve_surface_texture(
    texture_id: u32,
    decoder: &mut EntityDecoder,
    cache: &mut FxHashMap<u32, Option<TextureSource>>,
) -> Option<TextureSource> {
    if let Some(cached) = cache.get(&texture_id) {
        return cached.clone();
    }
    let resolved = decoder.decode_by_id(texture_id).ok().and_then(|entity| {
        match entity.ifc_type {
            IfcType::IfcBlobTexture => decode_blob_texture(&entity)
                .map(|t| TextureSource::Decoded(Arc::new(t))),
            IfcType::IfcPixelTexture => decode_pixel_texture(&entity)
                .map(|t| TextureSource::Decoded(Arc::new(t))),
            IfcType::IfcImageTexture => read_image_texture(&entity).map(TextureSource::Image),
            _ => None,
        }
    });
    cache.insert(texture_id, resolved.clone());
    resolved
}

/// Resolve a single `IfcIndexedTriangleTextureMap` entity into a
/// [`ResolvedTextureMap`] keyed by the face set it maps to.
/// Attributes: Maps(0 = list of IfcSurfaceTexture), MappedTo(1 = face set),
/// TexCoords(2 = IfcTextureVertexList), TexCoordIndex(3 = list of 3 ints).
fn resolve_triangle_texture_map(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    texture_cache: &mut FxHashMap<u32, Option<TextureSource>>,
) -> Option<(u32, ResolvedTextureMap)> {
    let face_set_id = entity.get_ref(1)?;

    // Maps[0] → surface texture.
    let maps = entity.get(0)?.as_list()?;
    let texture_id = maps.iter().find_map(|m| m.as_entity_ref())?;
    let texture = resolve_surface_texture(texture_id, decoder, texture_cache)?;

    // TexCoords → IfcTextureVertexList.TexCoordsList (attr 0). Use `map` +
    // `collect::<Option<_>>` (NOT filter_map): a malformed entry must reject the
    // whole map, not silently drop a row. Dropping one shifts every later row
    // left, and `tex_coord_index[n]` must stay parallel to triangle `n` in
    // build_flat_shaded_mesh_with_uvs — a compressed list scrambles all UVs.
    let tvl_id = entity.get_ref(2)?;
    let tvl = decoder.decode_by_id(tvl_id).ok()?;
    let coord_list = tvl.get(0)?.as_list()?;
    let tex_coords: Vec<[f32; 2]> = coord_list
        .iter()
        .map(|c| {
            let uv = c.as_list()?;
            let u = uv.first().and_then(|v| v.as_float())? as f32;
            let v = uv.get(1).and_then(|v| v.as_float())? as f32;
            Some([u, v])
        })
        .collect::<Option<Vec<_>>>()?;
    if tex_coords.is_empty() {
        return None;
    }

    // TexCoordIndex (attr 3) → per-triangle [i, j, k]. Same all-or-nothing rule
    // so the index stays 1:1 with the triangle list. `$` (null) is VALID per
    // spec — texture vertices then pair 1:1 with the face set's Coordinates and
    // its CoordIndex doubles as the UV index (`None` here; the mesher derives
    // the per-triangle index from the face set itself, #1781).
    let tex_coord_index: Option<Vec<[u32; 3]>> = match entity.get(3) {
        Some(attr) if !attr.is_null() => {
            let index_attr = attr.as_list()?;
            let idx: Vec<[u32; 3]> = index_attr
                .iter()
                .map(|tri| {
                    let t = tri.as_list()?;
                    let a = t.first().and_then(|v| v.as_int())? as u32;
                    let b = t.get(1).and_then(|v| v.as_int())? as u32;
                    let c = t.get(2).and_then(|v| v.as_int())? as u32;
                    Some([a, b, c])
                })
                .collect::<Option<Vec<_>>>()?;
            if idx.is_empty() {
                return None;
            }
            Some(idx)
        }
        _ => None,
    };

    Some((
        face_set_id,
        ResolvedTextureMap {
            texture_id,
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
    content: &[u8],
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, ResolvedTextureMap> {
    let mut index = FxHashMap::default();
    if memchr::memmem::find(content, b"IFCINDEXEDTRIANGLETEXTUREMAP").is_none() {
        return index;
    }
    let mut texture_cache: FxHashMap<u32, Option<TextureSource>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCINDEXEDTRIANGLETEXTUREMAP" {
            continue;
        }
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some((face_set_id, resolved)) =
                resolve_triangle_texture_map(&entity, decoder, &mut texture_cache)
            {
                index.entry(face_set_id).or_insert(resolved);
            }
        }
    }
    index
}
