// SPDX-License-Identifier: MPL-2.0
//! glTF 2.0 / **GLB** exporter — triangulated render geometry as a binary glTF container.
//!
//! Source = `ifc_lite_processing::process_geometry` (the unified Rust mesh pipeline).
//! Mirrors the structure of the prior `packages/export/src/gltf-exporter.ts`:
//! KHR_materials_unlit, RGBA-deduped materials, one mesh+node per element, three
//! bufferViews (positions / normals / indices) packed into a single binary buffer.
//!
//! Improvement over the TS exporter: the per-mesh `origin` (RTC offset) is emitted as a
//! glTF **node translation** and positions stay LOCAL, so building/georef-scale placements
//! keep f32 vertex precision (node translation carries the large offset). When `origin` is
//! zero (local-frame feature off) the output is byte-equivalent to the old TS path.

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::ExportError;
use ifc_lite_core::EntityIndex;
use ifc_lite_geometry::{collate_refs, InstanceMeshRef, InstanceMeta, InstanceTemplate};
use ifc_lite_processing::{
    process_geometry, process_geometry_streaming_filtered_with_options, process_geometry_with_index,
    MeshData, OpeningFilterMode, ProcessingResult, StreamingOptions,
};
use serde::Serialize;
use serde_json::{json, Value};

/// Options for glTF/GLB export.
pub struct GltfOptions {
    /// Attach `asset.extras` (counts) and per-node `extras.expressId`.
    pub include_metadata: bool,
    /// Restrict to these express ids (isolation allowlist). Empty ⇒ all visible.
    pub isolated: Vec<u32>,
    /// Exclude these express ids (hidden in the viewer).
    pub hidden: Vec<u32>,
    /// Exclude meshes whose IFC type is in this set (class-level visibility toggle).
    pub hidden_types: Vec<String>,
    /// Emit standard (lit) PBR materials so external viewers shade the model from
    /// its normals. When `false`, materials are tagged `KHR_materials_unlit` and
    /// render flat with just the apparent base colour (the historical behaviour,
    /// kept for colour-accurate exports). Default `true`. (#1321)
    pub lit: bool,
    /// Per-model id stamped into every node's `extras.modelId` (federation: lets a
    /// host distinguish elements from different models that share express-id space).
    /// `None` ⇒ single model, no `modelId` emitted. Requires `include_metadata`.
    pub model_id: Option<String>,
    /// Quantize geometry with `KHR_mesh_quantization`: 16-bit SHORT positions +
    /// normals per-mesh over each mesh's own bbox, with the dequant on a node transform.
    /// ~2x smaller, precision-safe (sub-2 mm per-mesh on the measured corpus). Default
    /// `false` — the unquantized f32 output is byte-identical to before. three.js
    /// `GLTFLoader` decodes it natively, but a loader without the extension cannot open
    /// the file (it is `extensionsRequired`), so only enable when the consumer supports it.
    pub quantize: bool,
}

impl Default for GltfOptions {
    fn default() -> Self {
        Self {
            include_metadata: false,
            isolated: Vec::new(),
            hidden: Vec::new(),
            hidden_types: Vec::new(),
            lit: true,
            model_id: None,
            quantize: false,
        }
    }
}

/// Coverage stats for a GLB export.
pub struct GltfStats {
    pub meshes: usize,
    pub vertices: usize,
    pub triangles: usize,
    pub materials: usize,
}

// ── glTF 2.0 JSON schema (subset) ──────────────────────────────────────────

#[derive(Serialize)]
struct Gltf {
    asset: Asset,
    scene: u32,
    scenes: Vec<Scene>,
    nodes: Vec<Node>,
    meshes: Vec<Mesh>,
    #[serde(skip_serializing_if = "Option::is_none")]
    materials: Option<Vec<Material>>,
    accessors: Vec<Accessor>,
    #[serde(rename = "bufferViews")]
    buffer_views: Vec<BufferView>,
    buffers: Vec<Buffer>,
    #[serde(rename = "extensionsUsed", skip_serializing_if = "Option::is_none")]
    extensions_used: Option<Vec<&'static str>>,
    #[serde(rename = "extensionsRequired", skip_serializing_if = "Option::is_none")]
    extensions_required: Option<Vec<&'static str>>,
}

#[derive(Serialize)]
struct Asset {
    version: &'static str,
    generator: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    extras: Option<Value>,
}

#[derive(Serialize)]
struct Scene {
    nodes: Vec<u32>,
}

#[derive(Serialize)]
struct Node {
    #[serde(skip_serializing_if = "Option::is_none")]
    mesh: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<[f64; 3]>,
    // Per-mesh dequantization scale for the `KHR_mesh_quantization` path: maps the
    // normalized SHORT positions back to the mesh's local bbox half-extent. Combined with
    // `translation` it forms the dequant TRS; absent (and thus identity) on the f32 path.
    #[serde(skip_serializing_if = "Option::is_none")]
    scale: Option<[f64; 3]>,
    // Column-major 4x4 (glTF convention) placing an instanced occurrence's shared
    // template geometry at its world pose. Mutually exclusive with `translation`
    // (glTF forbids both on one node); instanced occurrence nodes use `matrix`,
    // flat/root nodes use `translation`.
    #[serde(skip_serializing_if = "Option::is_none")]
    matrix: Option<[f32; 16]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extras: Option<Value>,
}

#[derive(Serialize)]
struct Mesh {
    primitives: Vec<Primitive>,
}

#[derive(Serialize)]
struct Primitive {
    attributes: Attributes,
    indices: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    material: Option<u32>,
}

#[derive(Serialize)]
struct Attributes {
    #[serde(rename = "POSITION")]
    position: u32,
    #[serde(rename = "NORMAL")]
    normal: u32,
}

#[derive(Serialize)]
struct Material {
    #[serde(rename = "pbrMetallicRoughness")]
    pbr: Pbr,
    // `Some` only for unlit exports (#1321); a lit material omits it entirely so
    // the viewer applies standard PBR lighting from the mesh normals.
    #[serde(skip_serializing_if = "Option::is_none")]
    extensions: Option<Extensions>,
    #[serde(rename = "alphaMode", skip_serializing_if = "Option::is_none")]
    alpha_mode: Option<&'static str>,
    // IFC face winding isn't reliably outward (the viewer renders cull-none /
    // double-sided), so single-sided glTF consumers would cull inward-wound or
    // coplanar faces → "missing geometry". Match the viewer: always double-sided.
    #[serde(rename = "doubleSided")]
    double_sided: bool,
}

#[derive(Serialize)]
struct Pbr {
    #[serde(rename = "baseColorFactor")]
    base_color_factor: [f32; 4],
    #[serde(rename = "metallicFactor")]
    metallic_factor: f32,
    #[serde(rename = "roughnessFactor")]
    roughness_factor: f32,
}

#[derive(Serialize)]
struct Extensions {
    #[serde(rename = "KHR_materials_unlit")]
    khr_materials_unlit: EmptyObj,
}

#[derive(Serialize)]
struct EmptyObj {}

#[derive(Serialize)]
struct Accessor {
    #[serde(rename = "bufferView")]
    buffer_view: u32,
    #[serde(rename = "byteOffset")]
    byte_offset: u32,
    #[serde(rename = "componentType")]
    component_type: u32,
    count: u32,
    #[serde(rename = "type")]
    ty: &'static str,
    // `KHR_mesh_quantization`: marks SHORT/BYTE position+normal accessors as normalized
    // (the renderer maps the integer range to [-1,1]). Omitted (None) on the f32 path.
    #[serde(skip_serializing_if = "Option::is_none")]
    normalized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<[f32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<[f32; 3]>,
}

#[derive(Serialize)]
struct BufferView {
    buffer: u32,
    #[serde(rename = "byteOffset")]
    byte_offset: u32,
    #[serde(rename = "byteLength")]
    byte_length: u32,
    #[serde(rename = "byteStride", skip_serializing_if = "Option::is_none")]
    byte_stride: Option<u32>,
    target: u32,
}

#[derive(Serialize)]
struct Buffer {
    #[serde(rename = "byteLength")]
    byte_length: u32,
    // Relative path to an external `.bin` (multi-buffer glTF). `None` for the embedded
    // GLB binary chunk (buffer 0, uri-less by spec) — omitted, so GLB output is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
}

// ── Build ───────────────────────────────────────────────────────────────────

fn mesh_visible(mesh: &MeshData, opts: &GltfOptions) -> bool {
    if mesh.geometry_class == 2 {
        return false; // instanced type library duplicates occurrence geometry
    }
    if opts.hidden.contains(&mesh.express_id) {
        return false;
    }
    if !opts.isolated.is_empty() && !opts.isolated.contains(&mesh.express_id) {
        return false;
    }
    if opts.hidden_types.iter().any(|t| t == &mesh.ifc_type) {
        return false;
    }
    // Geometry sanity: matching, non-empty, triangulated.
    !mesh.indices.is_empty()
        && mesh.positions.len() >= 9
        && mesh.positions.len().is_multiple_of(3)
        && mesh.normals.len() == mesh.positions.len()
}

/// Material dedup key: RGBA rounded to 2 decimals (matches the TS exporter's key).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// 128-bit content key for the flat-remainder dedup: the mesh's LOCAL geometry
/// (positions / normals / indices, hashed as raw bit patterns) folded with its
/// colour. Two meshes the rep-identity collator did NOT flag instanceable but whose
/// BAKED local buffers are nonetheless bit-identical (same shape, same orientation,
/// same colour) share one emitted glTF mesh placed by a node translation. Colour is
/// in the key because the glTF material rides the primitive, not the node. Two
/// independently-seeded streams give a 128-bit key (collision ~2^-127).
fn geom_color_key(positions: &[f32], normals: &[f32], indices: &[u32], color: [f32; 4]) -> u128 {
    use std::hash::{Hash, Hasher};
    let stream = |seed: u64| -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        seed.hash(&mut h);
        positions.len().hash(&mut h);
        for &p in positions {
            p.to_bits().hash(&mut h);
        }
        for &n in normals {
            n.to_bits().hash(&mut h);
        }
        indices.hash(&mut h);
        color_key(color).hash(&mut h);
        h.finish()
    };
    ((stream(0x9E37_79B9_7F4A_7C15) as u128) << 64) | stream(0xD1B5_4A32_D192_ED03) as u128
}

// ── Instancing matrix math (row-major f64 4x4) ──────────────────────────────
//
// An occurrence's node matrix must map the shared template's Y-up LOCAL geometry
// to that occurrence's Y-up BAKED world position, minus the model-wide
// `scene_center` that the root node carries:
//
//   N_k = T(-scene_center) · S · [ T(-rtc) · (M_k · M_ref⁻¹) · T(rtc) ] · S⁻¹ · T(template_origin_yup)
//
// where `M = transform · local · canonical` is the per-occurrence world placement
// from `InstanceMeta` (Z-up, **pre-RTC**), `rtc` is the model RTC/site offset the
// baker subtracted (Z-up), and `S` is the Z-up→Y-up basis `(x,y,z) → (x, z, -y)`.
// The `T(-rtc)·…·T(rtc)` conjugation moves the relative transform from the pre-RTC
// frame `M` lives in into the POST-RTC baked frame the template geometry is in —
// without it, a rotated occurrence under a non-zero site/georef offset is
// mis-translated by `(R_rel - I)·rtc` (kilometres at national-grid scale). Everything
// is f64, recomputed from the f64 `InstanceMeta` (NOT the collator's f32 `rel`), so
// the absolute-magnitude terms cancel to a small, f32-precise translation before the
// final downcast even at national-grid coordinates.

/// Z-up→Y-up basis as a row-major 4x4 (linear part only; `(x,y,z) → (x, z, -y)`).
const S_YUP: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, -1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];
/// Inverse (transpose, since `S_YUP` is a proper rotation): `(x,y,z) → (x, -z, y)`.
const S_YUP_INV: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, -1.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];
const IDENTITY16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];

/// Row-major 4x4 multiply `a · b`.
fn mat4_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[r * 4 + k] * b[k * 4 + c];
            }
            out[r * 4 + c] = s;
        }
    }
    out
}

/// Row-major translation matrix.
fn mat4_translation(t: [f64; 3]) -> [f64; 16] {
    [
        1.0, 0.0, 0.0, t[0], //
        0.0, 1.0, 0.0, t[1], //
        0.0, 0.0, 1.0, t[2], //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// Transpose a row-major f64 4x4 into the column-major `[f32; 16]` glTF expects.
fn row_major_f64_to_col_major_f32(m: &[f64; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[c * 4 + r] = m[r * 4 + c] as f32;
        }
    }
    out
}

/// Inverse of a row-major AFFINE 4x4 (last row `[0,0,0,1]`): invert the upper 3x3
/// (cofactor / determinant) and map the translation by `-R⁻¹·t`. Returns `None` if
/// the 3x3 is singular (degenerate placement) so the caller can fall back to flat.
fn affine_inverse(m: &[f64; 16]) -> Option<[f64; 16]> {
    let a = m[0]; let b = m[1]; let c = m[2];
    let d = m[4]; let e = m[5]; let f = m[6];
    let g = m[8]; let h = m[9]; let i = m[10];
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-18 {
        return None;
    }
    let inv_det = 1.0 / det;
    // Inverse of the 3x3 (row-major) via the transposed cofactor matrix.
    let r = [
        (e * i - f * h) * inv_det,
        (c * h - b * i) * inv_det,
        (b * f - c * e) * inv_det,
        (f * g - d * i) * inv_det,
        (a * i - c * g) * inv_det,
        (c * d - a * f) * inv_det,
        (d * h - e * g) * inv_det,
        (b * g - a * h) * inv_det,
        (a * e - b * d) * inv_det,
    ];
    let (tx, ty, tz) = (m[3], m[7], m[11]);
    // Translation of the inverse: -R⁻¹ · t.
    let it = [
        -(r[0] * tx + r[1] * ty + r[2] * tz),
        -(r[3] * tx + r[4] * ty + r[5] * tz),
        -(r[6] * tx + r[7] * ty + r[8] * tz),
    ];
    Some([
        r[0], r[1], r[2], it[0], //
        r[3], r[4], r[5], it[1], //
        r[6], r[7], r[8], it[2], //
        0.0, 0.0, 0.0, 1.0,
    ])
}

/// Compose an `InstanceMeta`'s world placement `transform · local · canonical`
/// (row-major f64), the same product the collator's `compose_world` builds.
fn compose_world_meta(meta: &InstanceMeta) -> [f64; 16] {
    let local = meta.local_transform.unwrap_or(IDENTITY16);
    let canonical = meta.canonical_transform.unwrap_or(IDENTITY16);
    mat4_mul(&meta.transform, &mat4_mul(&local, &canonical))
}

/// Build the column-major glTF node matrix placing a shared template (Y-up local
/// geometry, relative to `template_origin_yup`) at one occurrence's BAKED pose.
/// Recomputed in f64 from the occurrence's `InstanceMeta`, the precomputed template
/// inverse `m_ref_inv` (`affine_inverse(compose_world_meta(template))`, computed once
/// per group), and the model `rtc` offset (Z-up) the baker subtracted.
fn occurrence_node_matrix(
    occ: &InstanceMeta,
    m_ref_inv: &[f64; 16],
    rtc_zup: [f64; 3],
    template_origin_yup: [f64; 3],
    scene_center: [f64; 3],
) -> [f32; 16] {
    let m_k = compose_world_meta(occ);
    // rel maps the template's PRE-RTC world geometry onto occurrence k's.
    let rel_pre = mat4_mul(&m_k, m_ref_inv);
    // Conjugate into the POST-RTC baked frame the geometry actually lives in.
    let rel_baked = mat4_mul(
        &mat4_translation([-rtc_zup[0], -rtc_zup[1], -rtc_zup[2]]),
        &mat4_mul(&rel_pre, &mat4_translation(rtc_zup)),
    );
    // Conjugate Z-up→Y-up (the template was converted by the same S).
    let rel_yup = mat4_mul(&mat4_mul(&S_YUP, &rel_baked), &S_YUP_INV);
    let n = mat4_mul(
        &mat4_translation([-scene_center[0], -scene_center[1], -scene_center[2]]),
        &mat4_mul(&rel_yup, &mat4_translation(template_origin_yup)),
    );
    row_major_f64_to_col_major_f32(&n)
}

/// Streams geometry into one or more glTF buffers. Each buffer holds three bufferViews
/// (positions | normals | indices); a buffer is flushed when adding the next mesh would
/// push it over `cap`. With `cap = usize::MAX` and no `sink` it is a single embedded
/// buffer (the GLB path) and produces byte-identical output to writing the three Vecs
/// directly. With a `cap` and a `sink` it is multi-buffer glTF: each finished buffer's
/// `.bin` goes to the sink (kept out of memory) and gets an external `uri`.
struct Chunker<'s> {
    pos: Vec<u8>,
    norm: Vec<u8>,
    idx: Vec<u8>,
    buffer_views: Vec<BufferView>,
    buffers: Vec<Buffer>,
    vec3_stride: u32, // 8 quantized SHORT (6 tight + 2 pad), 12 f32
    cap: usize,
    next_buffer: u32,
    sink: Option<&'s mut dyn FnMut(String, Vec<u8>)>,
    embedded_bin: Vec<u8>, // the single chunk's bytes on the GLB path (sink == None)
}

impl<'s> Chunker<'s> {
    fn new(vec3_stride: u32, cap: usize, sink: Option<&'s mut dyn FnMut(String, Vec<u8>)>) -> Self {
        Self {
            pos: Vec::new(),
            norm: Vec::new(),
            idx: Vec::new(),
            buffer_views: Vec::new(),
            buffers: Vec::new(),
            vec3_stride,
            cap,
            next_buffer: 0,
            sink,
            embedded_bin: Vec::new(),
        }
    }

    /// The bufferView index the current (not-yet-flushed) chunk's POSITION will take.
    /// Normals are `+ 1`, indices `+ 2`. Stable until the next `flush`.
    fn bv_base(&self) -> u32 {
        self.buffer_views.len() as u32
    }

    /// Flush before pushing a mesh of `next_bytes` if it would overflow the current
    /// (non-empty) chunk. No-op at `cap = usize::MAX`.
    fn maybe_flush(&mut self, next_bytes: usize) {
        let used = self.pos.len() + self.norm.len() + self.idx.len();
        if used > 0 && used.saturating_add(next_bytes) > self.cap {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.pos.is_empty() {
            // The single-buffer GLB path keeps exactly one (possibly empty) buffer to
            // match the legacy output byte-for-byte; multi-buffer skips empty chunks.
            if self.sink.is_none() && self.next_buffer == 0 {
                self.buffers.push(Buffer { byte_length: 0, uri: None });
                self.next_buffer += 1;
            }
            return;
        }
        // Lengths in usize; assert the 4 GiB limit BEFORE narrowing to u32, so an
        // over-limit single buffer (GLB path, cap = usize::MAX) fails loudly with the
        // message the worker's `OutputTooLarge` classifier matches, rather than silently
        // wrapping `as u32` into a corrupt glTF (release builds set overflow-checks off).
        // Multi-buffer chunks are < cap, so they never approach this.
        let (pl, nl, il) = (self.pos.len(), self.norm.len(), self.idx.len());
        let total = pl + nl + il;
        assert!(
            total <= u32::MAX as usize,
            "GLB binary buffer is {total} bytes, over the glTF 32-bit buffer limit \
             (4 GiB); the model is too large for a single GLB",
        );
        let buf = self.next_buffer;
        self.buffer_views.push(BufferView {
            buffer: buf, byte_offset: 0, byte_length: pl as u32,
            byte_stride: Some(self.vec3_stride), target: 34962,
        });
        self.buffer_views.push(BufferView {
            buffer: buf, byte_offset: pl as u32, byte_length: nl as u32,
            byte_stride: Some(self.vec3_stride), target: 34962,
        });
        self.buffer_views.push(BufferView {
            buffer: buf, byte_offset: (pl + nl) as u32, byte_length: il as u32,
            byte_stride: None, target: 34963,
        });
        let mut bin = Vec::with_capacity(total);
        bin.extend_from_slice(&self.pos);
        bin.extend_from_slice(&self.norm);
        bin.extend_from_slice(&self.idx);
        self.pos.clear();
        self.norm.clear();
        self.idx.clear();
        match self.sink.as_mut() {
            Some(sink) => {
                let name = format!("buffer{buf}.bin");
                self.buffers.push(Buffer { byte_length: total as u32, uri: Some(name.clone()) });
                sink(name, bin);
            }
            None => {
                self.buffers.push(Buffer { byte_length: total as u32, uri: None });
                self.embedded_bin = bin;
            }
        }
        self.next_buffer += 1;
    }
}

/// Emit one mesh's geometry (positions/normals/indices baked by `vertex_offset`),
/// its three accessors, deduped material, and a glTF `Mesh`; returns the mesh
/// index. `vertex_offset` is added to each local position before the f32 downcast:
/// for a UNIQUE mesh it is `origin - scene_center` (the self-contained
/// world-minus-center bake), for a SHARED mesh it is zero (pure local geometry,
/// placed via the occurrence node's translation). Bumps the deduped `stats`.
#[allow(clippy::too_many_arguments)]
fn push_mesh(
    ch: &mut Chunker,
    accessors: &mut Vec<Accessor>,
    meshes: &mut Vec<Mesh>,
    materials: &mut Vec<Material>,
    material_map: &mut HashMap<(i32, i32, i32, i32), u32>,
    mesh: &MeshView,
    vertex_offset: [f64; 3],
    lit: bool,
    stats: &mut GltfStats,
) -> u32 {
    let nverts = (mesh.positions.len() / 3) as u32;
    // f32: 24 bytes/vertex (pos+normal) + 4/index. Flush before writing if needed.
    ch.maybe_flush(mesh.positions.len() * 8 + mesh.indices.len() * 4);
    let bv = ch.bv_base();
    let pos_off = ch.pos.len() as u32;
    let norm_off = ch.norm.len() as u32;
    let idx_off = ch.idx.len() as u32;

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            let baked = (p[k] as f64 + vertex_offset[k]) as f32;
            ch.pos.extend_from_slice(&baked.to_le_bytes());
            if baked < min[k] {
                min[k] = baked;
            }
            if baked > max[k] {
                max[k] = baked;
            }
        }
    }
    for &n in mesh.normals {
        ch.norm.extend_from_slice(&n.to_le_bytes());
    }
    for &i in mesh.indices {
        ch.idx.extend_from_slice(&i.to_le_bytes());
    }

    let pos_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv,
        byte_offset: pos_off,
        component_type: 5126, // FLOAT
        count: nverts,
        ty: "VEC3",
        normalized: None,
        min: Some(min),
        max: Some(max),
    });
    let norm_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv + 1,
        byte_offset: norm_off,
        component_type: 5126,
        count: nverts,
        ty: "VEC3",
        normalized: None,
        min: None,
        max: None,
    });
    let idx_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv + 2,
        byte_offset: idx_off,
        component_type: 5125, // UNSIGNED_INT
        count: mesh.indices.len() as u32,
        ty: "SCALAR",
        normalized: None,
        min: None,
        max: None,
    });

    let key = color_key(mesh.color);
    let material = *material_map.entry(key).or_insert_with(|| {
        let idx = materials.len() as u32;
        materials.push(Material {
            pbr: Pbr {
                base_color_factor: mesh.color,
                metallic_factor: 0.0,
                roughness_factor: 1.0,
            },
            extensions: if lit {
                None
            } else {
                Some(Extensions { khr_materials_unlit: EmptyObj {} })
            },
            alpha_mode: if mesh.color[3] < 1.0 { Some("BLEND") } else { None },
            double_sided: true,
        });
        idx
    });

    let mesh_idx = meshes.len() as u32;
    meshes.push(Mesh {
        primitives: vec![Primitive {
            attributes: Attributes { position: pos_acc, normal: norm_acc },
            indices: idx_acc,
            material: Some(material),
        }],
    });

    stats.meshes += 1;
    stats.vertices += nverts as usize;
    stats.triangles += mesh.indices.len() / 3;
    mesh_idx
}

/// Like [`push_mesh`] but emits `KHR_mesh_quantization` geometry: positions and
/// normals as **normalized SHORT**, indices as **u16** when the mesh has <= 65535 verts
/// (else u32). Positions are quantized per-mesh over the mesh's LOCAL bbox (no
/// `vertex_offset` bake) — the returned `(center, half_extent)` is the dequant the caller
/// folds onto the mesh's node (`local = center + half_extent * normalized`). Normals stay
/// unit directions in local space; the renderer's normal matrix (inverse-transpose of the
/// node's non-uniform dequant scale) restores world normals. Bumps the deduped `stats`.
#[allow(clippy::too_many_arguments)]
fn push_mesh_quantized(
    ch: &mut Chunker,
    accessors: &mut Vec<Accessor>,
    meshes: &mut Vec<Mesh>,
    materials: &mut Vec<Material>,
    material_map: &mut HashMap<(i32, i32, i32, i32), u32>,
    mesh: &MeshView,
    lit: bool,
    stats: &mut GltfStats,
) -> (u32, [f64; 3], [f64; 3]) {
    let nverts = (mesh.positions.len() / 3) as u32;
    // 16 bytes/vertex: SHORT pos + SHORT normal, each padded to an 8-byte stride; plus up
    // to 4 B/index. Used to decide whether to flush the chunk before writing this mesh.
    ch.maybe_flush(nverts as usize * 16 + mesh.indices.len() * 4);
    let bv = ch.bv_base();

    // Per-mesh bbox -> center + half-extent. Guard degenerate (flat/zero) axes so the
    // dequant scale is never zero (that axis quantizes to a constant 0).
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            let v = p[k] as f64;
            lo[k] = lo[k].min(v);
            hi[k] = hi[k].max(v);
        }
    }
    let mut center = [0.0f64; 3];
    let mut half = [1.0f64; 3];
    for k in 0..3 {
        center[k] = (lo[k] + hi[k]) * 0.5;
        let h = (hi[k] - lo[k]) * 0.5;
        if h > 0.0 {
            half[k] = h;
        }
    }

    // Positions: SHORT normalized, per-axis to [-32767, 32767], then a 4th SHORT of
    // padding. The pad makes the per-vertex stride 8 bytes: a bufferView shared by
    // multiple accessors must declare a `byteStride`, which glTF requires to be a
    // multiple of 4 (a tight SHORT VEC3 is 6).
    let pos_off = ch.pos.len() as u32;
    let mut qmin = [i16::MAX; 3];
    let mut qmax = [i16::MIN; 3];
    for p in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            let n = ((p[k] as f64 - center[k]) / half[k]).clamp(-1.0, 1.0);
            let q = (n * 32767.0).round() as i16;
            ch.pos.extend_from_slice(&q.to_le_bytes());
            qmin[k] = qmin[k].min(q);
            qmax[k] = qmax[k].max(q);
        }
        ch.pos.extend_from_slice(&0i16.to_le_bytes()); // pad to 8-byte stride
    }

    // Normals: SHORT normalized. The mesh node carries the non-uniform dequant scale
    // `half`, so the renderer applies its inverse-transpose `S(1/half)` to each stored
    // normal. Pre-multiply by `half` and renormalize so that cancels and the rendered
    // direction is the true normal. Padded to the same 8-byte stride as positions.
    let norm_off = ch.norm.len() as u32;
    for nrm in mesh.normals.chunks_exact(3) {
        let mut v = [
            nrm[0] as f64 * half[0],
            nrm[1] as f64 * half[1],
            nrm[2] as f64 * half[2],
        ];
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if len > 0.0 {
            v = [v[0] / len, v[1] / len, v[2] / len];
        }
        for c in v {
            let q = (c.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            ch.norm.extend_from_slice(&q.to_le_bytes());
        }
        ch.norm.extend_from_slice(&0i16.to_le_bytes()); // pad to 8-byte stride
    }

    // Indices: u16 when every index fits (max index = nverts - 1 <= 65535, i.e.
    // nverts <= 65536), else u32. Pad the section to 4 bytes so a following u32-index
    // mesh stays 4-aligned regardless of this mesh's index width.
    let small = nverts <= u16::MAX as u32 + 1;
    let idx_off = ch.idx.len() as u32;
    if small {
        for &i in mesh.indices {
            ch.idx.extend_from_slice(&(i as u16).to_le_bytes());
        }
    } else {
        for &i in mesh.indices {
            ch.idx.extend_from_slice(&i.to_le_bytes());
        }
    }
    while !ch.idx.len().is_multiple_of(4) {
        ch.idx.push(0);
    }

    let qf = |a: [i16; 3]| [a[0] as f32, a[1] as f32, a[2] as f32];
    let pos_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv,
        byte_offset: pos_off,
        component_type: 5122, // SHORT
        count: nverts,
        ty: "VEC3",
        normalized: Some(true),
        min: Some(qf(qmin)),
        max: Some(qf(qmax)),
    });
    let norm_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv + 1,
        byte_offset: norm_off,
        component_type: 5122,
        count: nverts,
        ty: "VEC3",
        normalized: Some(true),
        min: None,
        max: None,
    });
    let idx_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: bv + 2,
        byte_offset: idx_off,
        component_type: if small { 5123 } else { 5125 }, // UNSIGNED_SHORT / UNSIGNED_INT
        count: mesh.indices.len() as u32,
        ty: "SCALAR",
        normalized: None,
        min: None,
        max: None,
    });

    let key = color_key(mesh.color);
    let material = *material_map.entry(key).or_insert_with(|| {
        let idx = materials.len() as u32;
        materials.push(Material {
            pbr: Pbr {
                base_color_factor: mesh.color,
                metallic_factor: 0.0,
                roughness_factor: 1.0,
            },
            extensions: if lit {
                None
            } else {
                Some(Extensions { khr_materials_unlit: EmptyObj {} })
            },
            alpha_mode: if mesh.color[3] < 1.0 { Some("BLEND") } else { None },
            double_sided: true,
        });
        idx
    });

    let mesh_idx = meshes.len() as u32;
    meshes.push(Mesh {
        primitives: vec![Primitive {
            attributes: Attributes { position: pos_acc, normal: norm_acc },
            indices: idx_acc,
            material: Some(material),
        }],
    });

    stats.meshes += 1;
    stats.vertices += nverts as usize;
    stats.triangles += mesh.indices.len() / 3;
    (mesh_idx, center, half)
}

/// Per-node `extras` (`expressId` / `ifcType`, plus `GlobalId` / `modelId` when
/// available) when metadata is requested. `GlobalId` is the IFC EXPRESS attribute
/// (PascalCase); the others are synthetic, hence camelCase.
fn node_extras(
    include_metadata: bool,
    express_id: u32,
    ifc_type: &str,
    global_id: Option<&str>,
    model_id: Option<&str>,
) -> Option<Value> {
    if !include_metadata {
        return None;
    }
    let mut extras = json!({ "expressId": express_id, "ifcType": ifc_type });
    let obj = extras.as_object_mut().expect("json! built an object");
    if let Some(g) = global_id {
        // EXPRESS PascalCase for the IFC attribute, per the export naming convention
        // (AGENTS.md). `expressId`/`ifcType`/`modelId` are synthetic, hence camelCase.
        obj.insert("GlobalId".to_string(), json!(g));
    }
    if let Some(m) = model_id {
        obj.insert("modelId".to_string(), json!(m));
    }
    Some(extras)
}

/// Export the render geometry in `content` as a binary **GLB**.
pub fn export_glb(content: &[u8], opts: &GltfOptions) -> Vec<u8> {
    export_glb_with_stats(content, opts).0
}

/// A minimal borrowed view of one renderable mesh for glTF assembly — lets the
/// from-bytes path (`process_geometry`) and the from-meshes path (the viewer's already
/// produced MeshData) share one assembler.
pub struct MeshView<'a> {
    pub express_id: u32,
    pub ifc_type: &'a str,
    /// IFC `GlobalId` (GUID) of this element, when known. `None` on the
    /// from-meshes path, which carries only numeric express ids.
    pub global_id: Option<&'a str>,
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub indices: &'a [u32],
    pub color: [f32; 4],
    pub origin: [f64; 3],
    /// GPU-instancing side-channel (rep-identity + per-occurrence world transform),
    /// in the IFC **Z-up** frame. Present only on the from-bytes path (`process_geometry`);
    /// `None` on the from-meshes path (the viewer's MeshData drops it across the
    /// worker boundary) and for non-instanceable geometry. When two or more views
    /// share a `rep_identity`, the assembler emits the geometry once and places each
    /// occurrence with a node matrix. See [`assemble_glb`].
    pub instance: Option<&'a InstanceMeta>,
}

fn view_ok(v: &MeshView) -> bool {
    !v.indices.is_empty()
        && v.positions.len() >= 9
        && v.positions.len().is_multiple_of(3)
        && v.normals.len() == v.positions.len()
}

/// Core glTF/GLB assembler over pre-filtered mesh views.
///
/// Placement model (the fix for "all centre aligned"): each view's vertices are
/// LOCAL to its per-element `origin` (`world = origin + position`). We compute one
/// model-wide `scene_center`, bake `world - scene_center` into the f32 vertex
/// buffer, and ride the single large `scene_center` on ONE root-node translation
/// that parents every element node. This keeps vertices small (f32-precise even at
/// georef scale) AND self-contained: a consumer that ignores node transforms sees
/// the whole model uniformly offset, never each element collapsed onto the origin
/// (the failure mode of per-element `node.translation`).
///
/// `rtc_zup` is the model RTC / site-local offset (Z-up) that `process_geometry`
/// subtracted when baking vertices; the instancing path needs it to express each
/// occurrence's relative transform in the same POST-RTC frame the baked geometry
/// lives in. Pass `[0, 0, 0]` when geometry is already absolute (the from-meshes
/// path, which never instances anyway).
/// Build the glTF document, streaming geometry through `ch` (single embedded buffer for
/// GLB, or chunked external buffers for multi-buffer glTF). Returns the `Gltf` for the
/// caller to pack (GLB) or serialize (glTF); the binary lives in `ch` afterwards
/// (`ch.embedded_bin` for the single-buffer case, or already handed to the chunk sink).
fn build_gltf(
    views: &[MeshView],
    include_metadata: bool,
    model_id: Option<&str>,
    lit: bool,
    rtc_zup: [f64; 3],
    quantize: bool,
    ch: &mut Chunker,
) -> (Gltf, GltfStats) {
    // Pre-filter once so both passes (centre, then bake) see exactly the same set.
    let visible: Vec<&MeshView> = views.iter().filter(|v| view_ok(v)).collect();

    // ── Pass 1: one model-wide WORLD AABB → scene centre ────────────────────
    let mut wmin = [f64::INFINITY; 3];
    let mut wmax = [f64::NEG_INFINITY; 3];
    for v in &visible {
        let o = v.origin;
        for p in v.positions.chunks_exact(3) {
            for k in 0..3 {
                let w = p[k] as f64 + o[k];
                if w < wmin[k] {
                    wmin[k] = w;
                }
                if w > wmax[k] {
                    wmax[k] = w;
                }
            }
        }
    }
    let scene_center = if visible.is_empty() {
        [0.0, 0.0, 0.0]
    } else {
        [
            (wmin[0] + wmax[0]) * 0.5,
            (wmin[1] + wmax[1]) * 0.5,
            (wmin[2] + wmax[2]) * 0.5,
        ]
    };

    // Binary blobs, concatenated as [positions | normals | indices].

    let mut materials: Vec<Material> = Vec::new();
    let mut material_map: HashMap<(i32, i32, i32, i32), u32> = HashMap::new();

    let mut accessors: Vec<Accessor> = Vec::new();
    let mut meshes: Vec<Mesh> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut element_node_indices: Vec<u32> = Vec::new();

    let mut stats = GltfStats { meshes: 0, vertices: 0, triangles: 0, materials: 0 };

    // ── Pass 1.5: collate by representation identity ────────────────────────────
    // Group occurrences that share a representation (IfcMappedItem / repeated
    // geometry) so the geometry is emitted ONCE and each occurrence is placed with a
    // node matrix — the size win on repetitive models (50-85% fewer vertices). This
    // is the SAME rep-identity grouping the GPU/native instancing path uses;
    // content-hashing the BAKED f32 vertices cannot recover these repeats because
    // per-occurrence placement bakes distinct float positions. Meshes without usable
    // instance metadata (the from-meshes path, non-instanceable void-cut elements,
    // singletons) fall to `flat_indices` and keep the self-contained
    // world-minus-center bake above.
    let refs: Vec<InstanceMeshRef> = visible
        .iter()
        .map(|m| InstanceMeshRef {
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
            origin: m.origin,
            instance_meta: m.instance,
            entity_id: m.express_id,
            color: m.color,
        })
        .collect();
    // rtc [0,0,0]: this path keeps the RAW pre-RTC relative transforms and applies
    // its own `T(-rtc)·rel·T(rtc)` conjugation per occurrence in
    // `occurrence_node_matrix` (it has the Z-up model rtc there). Passing the rtc
    // here too would conjugate twice. The wasm GPU-shard path, which consumes the
    // relative transform directly (no downstream conjugation), passes the real rtc.
    let collated = collate_refs(&refs, 2, [0.0, 0.0, 0.0]);

    // Partition into instanced templates (non-rigid, exact-bit) and a flat remainder.
    // Only EXACT-bit groups are instanced: the template's local geometry IS each
    // occurrence's, so exported per-occurrence geometry stays byte-faithful. Rigid-
    // tier groups (rotation-normalized, env-gated and OFF by default) substitute a
    // congruent-but-not-identical template, so they fall to the flat remainder.
    let mut flat: Vec<usize> = collated.flat_indices.clone();
    let mut instanced: Vec<(&InstanceTemplate, [f64; 16])> =
        Vec::with_capacity(collated.templates.len());
    for template in &collated.templates {
        let rigid = template.occurrences.iter().any(|o| {
            visible[o.mesh_index]
                .instance
                .and_then(|m| m.canonical_transform)
                .is_some()
        });
        // Precompute the template's inverse world placement (f64) ONCE per group;
        // every occurrence's node matrix reuses it. A missing instance side-channel
        // or a singular/degenerate template placement routes the whole group to the
        // flat path (still correct, just not instanced).
        let m_ref_inv = (!rigid)
            .then(|| visible[template.template_index].instance)
            .flatten()
            .filter(|_| template.occurrences.iter().all(|o| visible[o.mesh_index].instance.is_some()))
            .and_then(|ti| affine_inverse(&compose_world_meta(ti)));
        match m_ref_inv {
            Some(inv) => instanced.push((template, inv)),
            None => flat.extend(template.occurrences.iter().map(|o| o.mesh_index)),
        }
    }

    // ── Pass 2: flat remainder, content-hash deduped ────────────────────────────
    // The rep-identity collator only groups geometry it can prove shareable. Many
    // models also have byte-identical BAKED meshes it does not flag (e.g. unmapped
    // repeated parts). Dedup those by local-geometry+colour content hash so they
    // still share one mesh placed by a node translation — this guarantees the
    // instanced output never regresses below the plain content-hash baseline.
    let flat_keys: Vec<u128> = flat
        .iter()
        .map(|&i| geom_color_key(visible[i].positions, visible[i].normals, visible[i].indices, visible[i].color))
        .collect();
    let mut flat_counts: HashMap<u128, u32> = HashMap::new();
    for &k in &flat_keys {
        *flat_counts.entry(k).or_insert(0) += 1;
    }
    // Cache key -> (mesh_idx, dequant center, dequant half-extent). The dequant fields
    // are dummy on the f32 path (node scale stays `None`); on the quantized path they
    // are the per-mesh dequant the node folds in.
    let mut flat_cache: HashMap<u128, (u32, [f64; 3], [f64; 3])> = HashMap::new();
    for (j, &idx) in flat.iter().enumerate() {
        let mesh = visible[idx];
        let placement = [
            mesh.origin[0] - scene_center[0],
            mesh.origin[1] - scene_center[1],
            mesh.origin[2] - scene_center[2],
        ];
        let key = flat_keys[j];
        let shared = flat_counts.get(&key).copied().unwrap_or(1) >= 2;
        let mesh_idx;
        let translation;
        let scale;
        if quantize {
            // Quantized: never bake. Emit per-mesh-local SHORT geometry and place +
            // dequantize on the node. `placement` is pure translation, so it commutes
            // with the dequant translate: node = T(placement + center) · S(half).
            let (mi, center, half) = if shared {
                *flat_cache.entry(key).or_insert_with(|| {
                    push_mesh_quantized(
                        &mut *ch, &mut accessors, &mut meshes,
                        &mut materials, &mut material_map, mesh, lit, &mut stats,
                    )
                })
            } else {
                push_mesh_quantized(
                    &mut *ch, &mut accessors, &mut meshes,
                    &mut materials, &mut material_map, mesh, lit, &mut stats,
                )
            };
            mesh_idx = mi;
            translation = Some([
                placement[0] + center[0],
                placement[1] + center[1],
                placement[2] + center[2],
            ]);
            scale = Some(half);
        } else if shared {
            // Repeated baked geometry: emit LOCAL once, place via node translation.
            let (mi, _, _) = *flat_cache.entry(key).or_insert_with(|| {
                let mi = push_mesh(
                    &mut *ch, &mut accessors, &mut meshes,
                    &mut materials, &mut material_map, mesh, [0.0, 0.0, 0.0], lit, &mut stats,
                );
                (mi, [0.0; 3], [0.0; 3])
            });
            mesh_idx = mi;
            translation = placement.iter().any(|c| c.abs() > 1e-9).then_some(placement);
            scale = None;
        } else {
            // Singleton: bake world-minus-center into the vertices, identity node.
            mesh_idx = push_mesh(
                &mut *ch, &mut accessors, &mut meshes,
                &mut materials, &mut material_map, mesh, placement, lit, &mut stats,
            );
            translation = None;
            scale = None;
        }
        let node_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: Some(mesh_idx),
            children: None,
            translation,
            scale,
            matrix: None,
            extras: node_extras(include_metadata, mesh.express_id, mesh.ifc_type, mesh.global_id, model_id),
        });
        element_node_indices.push(node_idx);
    }

    // ── Pass 2: instanced templates ─────────────────────────────────────────────
    for (template, m_ref_inv) in instanced {
        // glTF materials ride the mesh primitive, not the node, but the collator
        // groups by geometry only (`rep_identity` excludes colour). Split the
        // occurrences by colour so same-shape/different-colour occurrences get
        // distinct materials — one shared template mesh per colour bucket.
        let t_view = visible[template.template_index];
        let t_origin_yup = t_view.origin;
        // First-seen colour-bucket order keeps the emitted mesh/material/node
        // ordering deterministic (HashMap iteration order is not).
        let mut bucket_order: Vec<(i32, i32, i32, i32)> = Vec::new();
        let mut by_color: HashMap<(i32, i32, i32, i32), Vec<usize>> = HashMap::new();
        for (oi, occ) in template.occurrences.iter().enumerate() {
            let ck = color_key(visible[occ.mesh_index].color);
            by_color
                .entry(ck)
                .or_insert_with(|| {
                    bucket_order.push(ck);
                    Vec::new()
                })
                .push(oi);
        }
        for ck in &bucket_order {
            let bucket = &by_color[ck];
            let bucket_color = visible[template.occurrences[bucket[0]].mesh_index].color;
            // The shared mesh: the template's LOCAL geometry (vertex_offset = 0,
            // relative to the template origin) tinted with the bucket colour.
            let tmpl_mesh = MeshView {
                express_id: t_view.express_id,
                ifc_type: t_view.ifc_type,
                global_id: t_view.global_id,
                positions: t_view.positions,
                normals: t_view.normals,
                indices: t_view.indices,
                color: bucket_color,
                origin: t_view.origin,
                instance: None,
            };
            // Push the shared template once. Quantized returns the per-mesh dequant the
            // occurrence nodes need; f32 bakes nothing (`vertex_offset = 0`).
            let (mesh_idx, dequant) = if quantize {
                let (mi, center, half) = push_mesh_quantized(
                    &mut *ch, &mut accessors,
                    &mut meshes, &mut materials, &mut material_map, &tmpl_mesh, lit, &mut stats,
                );
                (mi, Some((center, half)))
            } else {
                let mi = push_mesh(
                    &mut *ch, &mut accessors,
                    &mut meshes, &mut materials, &mut material_map, &tmpl_mesh,
                    [0.0, 0.0, 0.0], lit, &mut stats,
                );
                (mi, None)
            };
            for &oi in bucket {
                let occ = &template.occurrences[oi];
                let occ_view = visible[occ.mesh_index];
                // Safe: the partition only kept this group when every occurrence has
                // an instance side-channel and the template inverse exists.
                let occ_meta = occ_view.instance.expect("instanced occurrence has InstanceMeta");
                let matrix = occurrence_node_matrix(
                    occ_meta, &m_ref_inv, rtc_zup, t_origin_yup, scene_center,
                );
                let extras = node_extras(include_metadata, occ_view.express_id, occ_view.ifc_type, occ_view.global_id, model_id);
                let node_idx = if let Some((center, half)) = dequant {
                    // Quantized: the dequant is a non-uniform scale; folding it into the
                    // occurrence matrix would make three.js `Matrix4.decompose` mangle the
                    // rotation·scale. Nest it on a child node instead. The MESH node keeps
                    // `extras` (a raycast pick hits the mesh), placement rides the parent.
                    let child_idx = nodes.len() as u32;
                    nodes.push(Node {
                        mesh: Some(mesh_idx),
                        children: None,
                        translation: Some(center),
                        scale: Some(half),
                        matrix: None,
                        extras,
                    });
                    let parent_idx = nodes.len() as u32;
                    nodes.push(Node {
                        mesh: None,
                        children: Some(vec![child_idx]),
                        translation: None,
                        scale: None,
                        matrix: Some(matrix),
                        extras: None,
                    });
                    parent_idx
                } else {
                    let ni = nodes.len() as u32;
                    nodes.push(Node {
                        mesh: Some(mesh_idx),
                        children: None,
                        translation: None,
                        scale: None,
                        matrix: Some(matrix),
                        extras,
                    });
                    ni
                };
                element_node_indices.push(node_idx);
            }
        }
    }
    stats.materials = materials.len();

    // Single root node carries the model-wide centre (omitted when ~zero) and
    // parents every element node, so the scene has exactly one top-level node.
    let center_nonzero = scene_center.iter().any(|c| c.abs() > 1e-9);
    let scene_nodes = if element_node_indices.is_empty() {
        Vec::new()
    } else {
        let root_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: None,
            children: Some(element_node_indices),
            translation: if center_nonzero { Some(scene_center) } else { None },
            scale: None,
            matrix: None,
            extras: None,
        });
        vec![root_idx]
    };

    // Flush the final (or only) chunk. The 4 GiB-per-buffer guard lives in `flush`; for
    // the single-buffer GLB path this is the same assert (and message) as before, so the
    // worker's `OutputTooLarge` classifier still matches. The container total (JSON +
    // framing) is guarded separately in `pack_glb`.
    ch.flush();

    let asset_extras = if include_metadata {
        Some(json!({
            "meshCount": stats.meshes,
            "vertexCount": stats.vertices,
            "triangleCount": stats.triangles,
        }))
    } else {
        None
    };

    let gltf = Gltf {
        asset: Asset { version: "2.0", generator: "IFC-Lite", extras: asset_extras },
        scene: 0,
        scenes: vec![Scene { nodes: scene_nodes }],
        nodes,
        meshes,
        materials: if materials.is_empty() { None } else { Some(materials) },
        accessors,
        buffer_views: std::mem::take(&mut ch.buffer_views),
        buffers: std::mem::take(&mut ch.buffers),
        extensions_used: {
            let mut ext: Vec<&'static str> = Vec::new();
            if !lit && stats.materials > 0 {
                ext.push("KHR_materials_unlit");
            }
            if quantize {
                ext.push("KHR_mesh_quantization");
            }
            (!ext.is_empty()).then_some(ext)
        },
        // `KHR_mesh_quantization` is hard-required: a loader without it cannot read the
        // SHORT-normalized attributes at all.
        extensions_required: quantize.then(|| vec!["KHR_mesh_quantization"]),
    };

    (gltf, stats)
}

/// Like [`export_glb`] but also returns coverage stats. Meshes the model from bytes.
///
/// NOTE: this path fails OPEN on an empty visible set — it returns a structurally
/// valid zero-mesh GLB reported as success. Prefer [`try_export_glb_with_stats`],
/// which turns that case into [`ExportError::NoRenderGeometry`] so no caller can
/// silently ship an empty artifact.
///
/// Inputs at or above the streaming threshold (default 64 MB, native override
/// `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) route to the bounded
/// two-pass assembler ([`export_glb_streaming_bounded`]) so a large model never
/// materializes all of its `MeshData` at once — the wasm-OOM fix. Small models
/// keep the in-memory instanced assembler (byte-identical to before).
pub fn export_glb_with_stats(content: &[u8], opts: &GltfOptions) -> (Vec<u8>, GltfStats) {
    if content.len() >= glb_stream_threshold_bytes() {
        return export_glb_streaming_bounded(content, opts);
    }
    export_glb_from_result(process_geometry(content), opts)
}

/// Fail-closed [`export_glb`]: an empty visible mesh set is an error, not a valid
/// empty GLB. Success implies the artifact contains at least one mesh, so every
/// caller (CLI, MCP, SDK, viewer, direct Rust) inherits the guard that previously
/// lived only in the TS wrappers.
pub fn try_export_glb(content: &[u8], opts: &GltfOptions) -> Result<Vec<u8>, ExportError> {
    try_export_glb_with_stats(content, opts).map(|(glb, _)| glb)
}

/// Fail-closed [`export_glb_with_stats`]; see [`try_export_glb`].
pub fn try_export_glb_with_stats(
    content: &[u8],
    opts: &GltfOptions,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    let (glb, stats) = export_glb_with_stats(content, opts);
    if stats.meshes == 0 {
        return Err(ExportError::NoRenderGeometry);
    }
    Ok((glb, stats))
}

/// Like [`export_glb_with_stats`] but reuses a pre-built entity index — for a caller
/// that also runs the attribute pass ([`crate::stream_export_model_with_index`]) over
/// the same bytes, `build_entity_index` once and share it across both. `index` MUST be
/// built from the same `content`; output is byte-identical to `export_glb_with_stats`
/// below the streaming threshold. NOTE: this path always uses the in-memory assembler
/// (the bounded two-pass path rebuilds its own index per pass and cannot reuse this
/// one); a native caller that needs bounded memory on a large model should call
/// [`export_glb_streaming_bounded`] directly.
pub fn export_glb_with_stats_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
) -> (Vec<u8>, GltfStats) {
    export_glb_from_result(process_geometry_with_index(content, index), opts)
}

/// Build the Y-up `MeshView`s + RTC offset from a `ProcessingResult` and run `f` over
/// them. Shared by the GLB (`export_glb_from_result`) and multi-buffer
/// (`export_gltf_streaming_from_result`) paths; the views borrow scratch that lives only
/// for `f`'s duration.
fn with_result_views<R>(
    result: ProcessingResult,
    opts: &GltfOptions,
    f: impl FnOnce(&[MeshView], [f64; 3]) -> R,
) -> R {
    // `process_geometry` emits the producer-native IFC **Z-up** frame (the Z-up→Y-up
    // swap normally happens at the wasm FFI, which this path never crosses). glTF
    // mandates +Y-up, so convert each visible mesh to Y-up — positions/normals
    // swapped, winding reversed, origin swapped — matching the viewer/legacy output.
    let visible: Vec<&MeshData> =
        result.meshes.iter().filter(|m| mesh_visible(m, opts)).collect();
    let yup: Vec<crate::frame::YUpMesh> = visible
        .iter()
        .map(|m| crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin))
        .collect();
    let views: Vec<MeshView> = visible
        .iter()
        .zip(yup.iter())
        .map(|(m, y)| MeshView {
            express_id: m.express_id,
            ifc_type: &m.ifc_type,
            global_id: m.global_id.as_deref(),
            positions: &y.positions,
            normals: &y.normals,
            indices: &y.indices,
            color: m.color,
            origin: y.origin,
            // Z-up instancing side-channel; rep-identity grouping is frame- and
            // bake-invariant (the assembler conjugates the transform into Y-up).
            instance: m.instance.as_ref(),
        })
        .collect();
    // RTC / site-local offset the baker subtracted (Z-up); the instancing path needs
    // it to place occurrences in the same POST-RTC frame the baked geometry lives in.
    let rtc_zup = result.metadata.coordinate_info.origin_shift;
    f(&views, rtc_zup)
}

fn export_glb_from_result(result: ProcessingResult, opts: &GltfOptions) -> (Vec<u8>, GltfStats) {
    with_result_views(result, opts, |views, rtc_zup| {
        let mut ch = Chunker::new(if opts.quantize { 8 } else { 12 }, usize::MAX, None);
        let (gltf, stats) = build_gltf(
            views, opts.include_metadata, opts.model_id.as_deref(), opts.lit, rtc_zup,
            opts.quantize, &mut ch,
        );
        let json = serde_json::to_vec(&gltf).expect("glTF JSON serializes");
        (pack_glb(&json, &ch.embedded_bin), stats)
    })
}

/// One finished external buffer of a multi-buffer glTF export.
pub struct GltfBuffer {
    /// The buffer's `uri` in the `.gltf` — write it as a sibling file / S3 object.
    pub name: String,
    /// The `.bin` payload. Dropped after the sink returns, so peak memory stays bounded.
    pub bytes: Vec<u8>,
}

/// Export a model as a **multi-buffer glTF**: the `.gltf` JSON (returned) plus one
/// or more external `.bin` buffers, each kept under `chunk_cap` bytes (well below the
/// 4 GiB glTF limit), so a model of ANY size loads as one logical model. Each finished
/// buffer is handed to `sink` and dropped, so peak memory is ~one chunk, not the whole
/// model — this is the path for models too large for a single GLB (`export_glb*` stays
/// the smaller-model path). Compose with `GltfOptions.quantize` to shrink first.
pub fn export_gltf_streaming(
    content: &[u8],
    opts: &GltfOptions,
    chunk_cap: usize,
    mut sink: impl FnMut(GltfBuffer),
) -> Vec<u8> {
    // Bounded memory: drive the streaming geometry API with `retain_emitted_meshes: false`
    // so meshes are never accumulated — peak input is one batch, not the whole model.
    // Two passes over the same (deterministic) mesh stream:
    //   pass 1 — the Y-up world AABB for `scene_center` (a precision-centering device, so
    //            any value is correct; the exact one keeps baked f32 magnitudes small);
    //   pass 2 — bake + encode each mesh as a flat node into the chunker, dropping it.
    // Instancing/content-dedup is skipped (it needs every mesh co-resident); the dense
    // models that actually need bounded memory have little instancing, and world geometry
    // is identical either way (instancing is only a dedup of repeated placements).
    let stream_opts =
        || StreamingOptions { retain_emitted_meshes: false, ..StreamingOptions::default() };

    let mut wmin = [f64::INFINITY; 3];
    let mut wmax = [f64::NEG_INFINITY; 3];
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !mesh_visible(m, opts) {
                    continue;
                }
                let y = crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin);
                for p in y.positions.chunks_exact(3) {
                    for k in 0..3 {
                        let w = p[k] as f64 + y.origin[k];
                        wmin[k] = wmin[k].min(w);
                        wmax[k] = wmax[k].max(w);
                    }
                }
            }
        },
        |_| {},
        |_| {},
    );
    let scene_center = if wmin[0].is_finite() {
        [
            (wmin[0] + wmax[0]) * 0.5,
            (wmin[1] + wmax[1]) * 0.5,
            (wmin[2] + wmax[2]) * 0.5,
        ]
    } else {
        [0.0; 3]
    };

    let mut accessors: Vec<Accessor> = Vec::new();
    let mut meshes: Vec<Mesh> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut materials: Vec<Material> = Vec::new();
    let mut material_map: HashMap<(i32, i32, i32, i32), u32> = HashMap::new();
    let mut element_node_indices: Vec<u32> = Vec::new();
    let mut stats = GltfStats { meshes: 0, vertices: 0, triangles: 0, materials: 0 };
    let mut adapt = |name: String, bytes: Vec<u8>| sink(GltfBuffer { name, bytes });
    let mut ch = Chunker::new(if opts.quantize { 8 } else { 12 }, chunk_cap, Some(&mut adapt));

    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !mesh_visible(m, opts) {
                    continue;
                }
                let y = crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin);
                let view = MeshView {
                    express_id: m.express_id,
                    ifc_type: &m.ifc_type,
                    global_id: m.global_id.as_deref(),
                    positions: &y.positions,
                    normals: &y.normals,
                    indices: &y.indices,
                    color: m.color,
                    origin: y.origin,
                    instance: None,
                };
                if !view_ok(&view) {
                    continue;
                }
                let placement = [
                    y.origin[0] - scene_center[0],
                    y.origin[1] - scene_center[1],
                    y.origin[2] - scene_center[2],
                ];
                let mesh_idx;
                let translation;
                let scale;
                if opts.quantize {
                    let (mi, center, half) = push_mesh_quantized(
                        &mut ch, &mut accessors, &mut meshes, &mut materials,
                        &mut material_map, &view, opts.lit, &mut stats,
                    );
                    mesh_idx = mi;
                    translation = Some([
                        placement[0] + center[0],
                        placement[1] + center[1],
                        placement[2] + center[2],
                    ]);
                    scale = Some(half);
                } else {
                    mesh_idx = push_mesh(
                        &mut ch, &mut accessors, &mut meshes, &mut materials,
                        &mut material_map, &view, placement, opts.lit, &mut stats,
                    );
                    translation = None;
                    scale = None;
                }
                let node_idx = nodes.len() as u32;
                nodes.push(Node {
                    mesh: Some(mesh_idx),
                    children: None,
                    translation,
                    scale,
                    matrix: None,
                    extras: node_extras(
                        opts.include_metadata, m.express_id, &m.ifc_type,
                        m.global_id.as_deref(), opts.model_id.as_deref(),
                    ),
                });
                element_node_indices.push(node_idx);
            }
        },
        |_| {},
        |_| {},
    );
    stats.materials = materials.len();

    // Single root node carries the model-wide centre and parents every element node.
    let center_nonzero = scene_center.iter().any(|c| c.abs() > 1e-9);
    let scene_nodes = if element_node_indices.is_empty() {
        Vec::new()
    } else {
        let root_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: None,
            children: Some(element_node_indices),
            translation: if center_nonzero { Some(scene_center) } else { None },
            scale: None,
            matrix: None,
            extras: None,
        });
        vec![root_idx]
    };
    ch.flush();

    let asset_extras = opts.include_metadata.then(|| {
        json!({
            "meshCount": stats.meshes,
            "vertexCount": stats.vertices,
            "triangleCount": stats.triangles,
        })
    });
    let gltf = Gltf {
        asset: Asset { version: "2.0", generator: "IFC-Lite", extras: asset_extras },
        scene: 0,
        scenes: vec![Scene { nodes: scene_nodes }],
        nodes,
        meshes,
        materials: if materials.is_empty() { None } else { Some(materials) },
        accessors,
        buffer_views: std::mem::take(&mut ch.buffer_views),
        buffers: std::mem::take(&mut ch.buffers),
        extensions_used: {
            let mut ext: Vec<&'static str> = Vec::new();
            if !opts.lit && stats.materials > 0 {
                ext.push("KHR_materials_unlit");
            }
            if opts.quantize {
                ext.push("KHR_mesh_quantization");
            }
            (!ext.is_empty()).then_some(ext)
        },
        extensions_required: opts.quantize.then(|| vec!["KHR_mesh_quantization"]),
    };
    serde_json::to_vec(&gltf).expect("glTF JSON serializes")
}

// ── Bounded-memory single-GLB export ─────────────────────────────────────────

/// Per-mesh record from the metadata streaming pass: everything the glTF JSON
/// needs, WITHOUT the vertex bytes (those are re-streamed and written directly
/// into the output on the second pass).
struct StreamedMeshMeta {
    express_id: u32,
    ifc_type: String,
    global_id: Option<String>,
    color: [f32; 4],
    /// Y-up per-element origin (world = origin + position).
    origin: [f64; 3],
    nverts: u32,
    nidx: u32,
    /// Local (pre-bake) f32 position bbox. Because `x as f32` is monotonic, the
    /// baked accessor min/max equal `(local as f64 + vertex_offset) as f32`
    /// exactly — no second pass needed to fill the JSON.
    local_min: [f32; 3],
    local_max: [f32; 3],
    /// Content-dedup key (local geometry + colour), same as the in-memory flat path.
    key: u128,
    /// `Some(write)` when this occurrence emits geometry bytes on pass 2;
    /// `None` when it shares a previously emitted mesh (content-hash dedup).
    write: Option<StreamedWrite>,
}

/// Byte destinations (offsets WITHIN each run) + bake parameters for one emitted mesh.
struct StreamedWrite {
    pos_off: u64,
    norm_off: u64,
    idx_off: u64,
    /// f32 path: added to each position (f64) before the f32 downcast:
    /// `origin - scene_center` for singletons, zero for shared meshes.
    vertex_offset: [f64; 3],
    /// Quantized path: `(center, half, small_indices)` for the SHORT encoding
    /// (the node carries the dequant); `vertex_offset` is unused when set.
    quant: Option<([f64; 3], [f64; 3], bool)>,
}

/// Input-size threshold (bytes) above which `export_glb_with_stats` uses the
/// bounded streaming assembler instead of the in-memory instanced one.
/// `IFC_LITE_GLB_STREAM_THRESHOLD_MB` overrides on native (`0` disables
/// streaming entirely); wasm has no environment, so the default always applies
/// there — which is the point: the wasm path must never build the whole model
/// in memory for large inputs.
fn glb_stream_threshold_bytes() -> usize {
    // 64 MB: 2x under the smallest input reported to trap the wasm heap (131 MB),
    // while instancing-heavy mid-size models (which lose rep-identity dedup on
    // the streaming path) keep the in-memory instanced assembler.
    const DEFAULT_MB: usize = 64;
    let mb = std::env::var("IFC_LITE_GLB_STREAM_THRESHOLD_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MB);
    if mb == 0 {
        return usize::MAX;
    }
    mb.saturating_mul(1024 * 1024)
}

/// Bounded-memory single-**GLB** export: two passes over the deterministic mesh
/// stream (`retain_emitted_meshes: false`, peak input = one batch).
///
/// Pass 1 records per-mesh METADATA only (counts, local bbox, colour, ids,
/// content-hash) plus the world AABB; the complete glTF JSON is then built and
/// the final GLB `Vec` is preallocated at its exact container size. Pass 2
/// re-streams the same meshes and bakes their bytes straight into the output at
/// precomputed offsets. Peak memory = the final artifact + one batch + metadata
/// — never the whole model's `MeshData`, never a growing three-run scratch, and
/// never a second full copy from a final concatenation.
///
/// Tradeoffs vs the in-memory assembler (`build_gltf`):
/// - rep-identity instancing is SKIPPED (it needs every occurrence co-resident);
///   content-hash dedup is kept (the hash is computed batch-locally on pass 1).
///   Models with no instanceable groups produce BYTE-IDENTICAL output; models
///   with them produce the same world geometry, larger by the forgone dedup.
/// - the model is meshed twice (the price of bounded memory).
///
/// Supports both the f32 and the `KHR_mesh_quantization` layouts; the quantized
/// accessor min/max come from the local bbox in closed form (the quantize map is
/// monotone per axis). Caveat: a NaN vertex coordinate quantizes to 0 in the
/// byte stream on both paths, but only the in-memory fold lets that 0 into the
/// accessor min/max hint; clean meshes are byte-identical.
pub fn export_glb_streaming_bounded(content: &[u8], opts: &GltfOptions) -> (Vec<u8>, GltfStats) {
    let stream_opts =
        || StreamingOptions { retain_emitted_meshes: false, ..StreamingOptions::default() };

    // ── Pass 1: metadata + world AABB ────────────────────────────────────────
    let mut metas: Vec<StreamedMeshMeta> = Vec::new();
    let mut wmin = [f64::INFINITY; 3];
    let mut wmax = [f64::NEG_INFINITY; 3];
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !mesh_visible(m, opts) {
                    continue;
                }
                let y = crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin);
                // Same geometry-sanity gate as `view_ok` on the in-memory path.
                if y.indices.is_empty()
                    || y.positions.len() < 9
                    || !y.positions.len().is_multiple_of(3)
                    || y.normals.len() != y.positions.len()
                {
                    continue;
                }
                let mut lmin = [f32::INFINITY; 3];
                let mut lmax = [f32::NEG_INFINITY; 3];
                for p in y.positions.chunks_exact(3) {
                    for (k, &v) in p.iter().enumerate() {
                        if v < lmin[k] {
                            lmin[k] = v;
                        }
                        if v > lmax[k] {
                            lmax[k] = v;
                        }
                    }
                }
                // World AABB from the local bbox: `x as f64` is exact and the fold
                // is order-independent, so this equals the in-memory per-vertex fold.
                for k in 0..3 {
                    wmin[k] = wmin[k].min(lmin[k] as f64 + y.origin[k]);
                    wmax[k] = wmax[k].max(lmax[k] as f64 + y.origin[k]);
                }
                metas.push(StreamedMeshMeta {
                    express_id: m.express_id,
                    ifc_type: m.ifc_type.clone(),
                    global_id: m.global_id.clone(),
                    color: m.color,
                    origin: y.origin,
                    nverts: (y.positions.len() / 3) as u32,
                    nidx: y.indices.len() as u32,
                    local_min: lmin,
                    local_max: lmax,
                    key: geom_color_key(&y.positions, &y.normals, &y.indices, m.color),
                    write: None,
                });
            }
        },
        |_| {},
        |_| {},
    );
    let scene_center = if metas.is_empty() {
        [0.0, 0.0, 0.0]
    } else {
        [
            (wmin[0] + wmax[0]) * 0.5,
            (wmin[1] + wmax[1]) * 0.5,
            (wmin[2] + wmax[2]) * 0.5,
        ]
    };

    // ── Build the glTF JSON (mirrors build_gltf's flat branch exactly) ──────
    let mut key_counts: HashMap<u128, u32> = HashMap::new();
    for meta in &metas {
        *key_counts.entry(meta.key).or_insert(0) += 1;
    }
    let mut accessors: Vec<Accessor> = Vec::new();
    let mut meshes: Vec<Mesh> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut materials: Vec<Material> = Vec::new();
    let mut material_map: HashMap<(i32, i32, i32, i32), u32> = HashMap::new();
    let mut element_node_indices: Vec<u32> = Vec::new();
    let mut stats = GltfStats { meshes: 0, vertices: 0, triangles: 0, materials: 0 };
    // key -> (mesh_idx, dequant center, dequant half). center/half are dummy
    // zeros/ones on the f32 path (node scale stays None), the per-mesh dequant
    // the node folds in on the quantized path (mirrors build_gltf's flat_cache).
    let mut shared_cache: HashMap<u128, (u32, [f64; 3], [f64; 3])> = HashMap::new();
    let (mut pos_len, mut norm_len, mut idx_len) = (0u64, 0u64, 0u64);
    let quantize = opts.quantize;

    // First simulation pass computes run lengths so accessor emission below can
    // reference stable bufferView indices (0/1/2) with per-run byte offsets.
    // Emission order = stream order, geometry emitted on a shared key's FIRST
    // occurrence only — identical to the in-memory flat pass.
    struct Emitted {
        mesh_idx: u32,
        translation: Option<[f64; 3]>,
        scale: Option<[f64; 3]>,
    }
    let mut per_meta: Vec<Emitted> = Vec::with_capacity(metas.len());
    for meta in &mut metas {
        let placement = [
            meta.origin[0] - scene_center[0],
            meta.origin[1] - scene_center[1],
            meta.origin[2] - scene_center[2],
        ];
        let shared = key_counts.get(&meta.key).copied().unwrap_or(1) >= 2;
        // Per-mesh dequant frame (quantized layout): centre + half-extent of the
        // LOCAL bbox, degenerate axes guarded to 1, exactly as push_mesh_quantized.
        let (q_center, q_half) = {
            let mut c = [0.0f64; 3];
            let mut h = [1.0f64; 3];
            for k in 0..3 {
                let lo = meta.local_min[k] as f64;
                let hi = meta.local_max[k] as f64;
                c[k] = (lo + hi) * 0.5;
                let hh = (hi - lo) * 0.5;
                if hh > 0.0 {
                    h[k] = hh;
                }
            }
            (c, h)
        };
        let emit = !(shared && shared_cache.contains_key(&meta.key));
        // f32 path only: singletons bake world-minus-centre into the vertices.
        let vertex_offset =
            if shared || quantize { [0.0, 0.0, 0.0] } else { placement };
        let (mesh_idx, center, half) = if emit {
            let (pos_acc, norm_acc, idx_acc) = if quantize {
                // Quantize is monotone per axis, so the accessor min/max are the
                // quantized local bbox corners in closed form.
                let q1 = |v: f32, k: usize| -> f32 {
                    let n = ((v as f64 - q_center[k]) / q_half[k]).clamp(-1.0, 1.0);
                    ((n * 32767.0).round() as i16) as f32
                };
                let qv = |v: [f32; 3]| [q1(v[0], 0), q1(v[1], 1), q1(v[2], 2)];
                let pos_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 0,
                    byte_offset: pos_len as u32,
                    component_type: 5122, // SHORT
                    count: meta.nverts,
                    ty: "VEC3",
                    normalized: Some(true),
                    min: Some(qv(meta.local_min)),
                    max: Some(qv(meta.local_max)),
                });
                let norm_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 1,
                    byte_offset: norm_len as u32,
                    component_type: 5122,
                    count: meta.nverts,
                    ty: "VEC3",
                    normalized: Some(true),
                    min: None,
                    max: None,
                });
                let small = meta.nverts <= u16::MAX as u32 + 1;
                let idx_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 2,
                    byte_offset: idx_len as u32,
                    component_type: if small { 5123 } else { 5125 },
                    count: meta.nidx,
                    ty: "SCALAR",
                    normalized: None,
                    min: None,
                    max: None,
                });
                (pos_acc, norm_acc, idx_acc)
            } else {
                let bake = |local: [f32; 3]| -> [f32; 3] {
                    [
                        (local[0] as f64 + vertex_offset[0]) as f32,
                        (local[1] as f64 + vertex_offset[1]) as f32,
                        (local[2] as f64 + vertex_offset[2]) as f32,
                    ]
                };
                let pos_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 0,
                    byte_offset: pos_len as u32,
                    component_type: 5126,
                    count: meta.nverts,
                    ty: "VEC3",
                    normalized: None,
                    min: Some(bake(meta.local_min)),
                    max: Some(bake(meta.local_max)),
                });
                let norm_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 1,
                    byte_offset: norm_len as u32,
                    component_type: 5126,
                    count: meta.nverts,
                    ty: "VEC3",
                    normalized: None,
                    min: None,
                    max: None,
                });
                let idx_acc = accessors.len() as u32;
                accessors.push(Accessor {
                    buffer_view: 2,
                    byte_offset: idx_len as u32,
                    component_type: 5125,
                    count: meta.nidx,
                    ty: "SCALAR",
                    normalized: None,
                    min: None,
                    max: None,
                });
                (pos_acc, norm_acc, idx_acc)
            };
            let material = *material_map.entry(color_key(meta.color)).or_insert_with(|| {
                let idx = materials.len() as u32;
                materials.push(Material {
                    pbr: Pbr {
                        base_color_factor: meta.color,
                        metallic_factor: 0.0,
                        roughness_factor: 1.0,
                    },
                    extensions: if opts.lit {
                        None
                    } else {
                        Some(Extensions { khr_materials_unlit: EmptyObj {} })
                    },
                    alpha_mode: if meta.color[3] < 1.0 { Some("BLEND") } else { None },
                    double_sided: true,
                });
                idx
            });
            let mesh_idx = meshes.len() as u32;
            meshes.push(Mesh {
                primitives: vec![Primitive {
                    attributes: Attributes { position: pos_acc, normal: norm_acc },
                    indices: idx_acc,
                    material: Some(material),
                }],
            });
            stats.meshes += 1;
            stats.vertices += meta.nverts as usize;
            stats.triangles += meta.nidx as usize / 3;
            let small = meta.nverts <= u16::MAX as u32 + 1;
            meta.write = Some(StreamedWrite {
                pos_off: pos_len,
                norm_off: norm_len,
                idx_off: idx_len,
                vertex_offset,
                quant: quantize.then_some((q_center, q_half, small)),
            });
            if quantize {
                pos_len += meta.nverts as u64 * 8;
                norm_len += meta.nverts as u64 * 8;
                idx_len += meta.nidx as u64 * if small { 2 } else { 4 };
                // The in-memory chunker pads the index run to 4-byte alignment
                // after every mesh; mirror it so offsets and lengths agree.
                idx_len = idx_len.div_ceil(4) * 4;
            } else {
                pos_len += meta.nverts as u64 * 12;
                norm_len += meta.nverts as u64 * 12;
                idx_len += meta.nidx as u64 * 4;
            }
            if shared {
                shared_cache.insert(meta.key, (mesh_idx, q_center, q_half));
            }
            (mesh_idx, q_center, q_half)
        } else {
            shared_cache[&meta.key]
        };
        let (translation, scale) = if quantize {
            // Placement is pure translation, so it commutes with the dequant
            // translate: node = T(placement + center) · S(half).
            (
                Some([
                    placement[0] + center[0],
                    placement[1] + center[1],
                    placement[2] + center[2],
                ]),
                Some(half),
            )
        } else if shared {
            (
                placement.iter().any(|c| c.abs() > 1e-9).then_some(placement),
                None,
            )
        } else {
            (None, None)
        };
        per_meta.push(Emitted { mesh_idx, translation, scale });
    }
    for (meta, emitted) in metas.iter().zip(&per_meta) {
        let node_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: Some(emitted.mesh_idx),
            children: None,
            translation: emitted.translation,
            scale: emitted.scale,
            matrix: None,
            extras: node_extras(
                opts.include_metadata,
                meta.express_id,
                &meta.ifc_type,
                meta.global_id.as_deref(),
                opts.model_id.as_deref(),
            ),
        });
        element_node_indices.push(node_idx);
    }
    stats.materials = materials.len();

    let bin_total = pos_len + norm_len + idx_len;
    // Same message as Chunker::flush so the worker's `OutputTooLarge` classifier
    // matches regardless of which assembler tripped.
    assert!(
        bin_total <= u32::MAX as u64,
        "GLB binary buffer is {bin_total} bytes, over the glTF 32-bit buffer limit \
         (4 GiB); the model is too large for a single GLB",
    );
    let (buffers, buffer_views) = if bin_total == 0 && stats.meshes == 0 {
        (vec![Buffer { byte_length: 0, uri: None }], Vec::new())
    } else {
        (
            vec![Buffer { byte_length: bin_total as u32, uri: None }],
            vec![
                BufferView {
                    buffer: 0,
                    byte_offset: 0,
                    byte_length: pos_len as u32,
                    byte_stride: Some(if quantize { 8 } else { 12 }),
                    target: 34962,
                },
                BufferView {
                    buffer: 0,
                    byte_offset: pos_len as u32,
                    byte_length: norm_len as u32,
                    byte_stride: Some(if quantize { 8 } else { 12 }),
                    target: 34962,
                },
                BufferView {
                    buffer: 0,
                    byte_offset: (pos_len + norm_len) as u32,
                    byte_length: idx_len as u32,
                    byte_stride: None,
                    target: 34963,
                },
            ],
        )
    };

    let center_nonzero = scene_center.iter().any(|c| c.abs() > 1e-9);
    let scene_nodes = if element_node_indices.is_empty() {
        Vec::new()
    } else {
        let root_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: None,
            children: Some(element_node_indices),
            translation: if center_nonzero { Some(scene_center) } else { None },
            scale: None,
            matrix: None,
            extras: None,
        });
        vec![root_idx]
    };

    let asset_extras = opts.include_metadata.then(|| {
        json!({
            "meshCount": stats.meshes,
            "vertexCount": stats.vertices,
            "triangleCount": stats.triangles,
        })
    });
    let gltf = Gltf {
        asset: Asset { version: "2.0", generator: "IFC-Lite", extras: asset_extras },
        scene: 0,
        scenes: vec![Scene { nodes: scene_nodes }],
        nodes,
        meshes,
        materials: if materials.is_empty() { None } else { Some(materials) },
        accessors,
        buffer_views,
        buffers,
        extensions_used: {
            let mut ext: Vec<&'static str> = Vec::new();
            if !opts.lit && stats.materials > 0 {
                ext.push("KHR_materials_unlit");
            }
            if quantize {
                ext.push("KHR_mesh_quantization");
            }
            (!ext.is_empty()).then_some(ext)
        },
        extensions_required: quantize.then(|| vec!["KHR_mesh_quantization"]),
    };
    let json = serde_json::to_vec(&gltf).expect("glTF JSON serializes");

    // ── Preallocate the exact GLB container, then pass 2 writes into it ─────
    let json_pad = (4 - (json.len() % 4)) % 4;
    let bin_pad = ((4 - (bin_total % 4)) % 4) as usize;
    let padded_json = json.len() + json_pad;
    let padded_bin = bin_total as usize + bin_pad;
    let total = 12 + 8 + padded_json + 8 + padded_bin;
    // Same message as pack_glb (the authoritative container guard).
    assert!(
        total <= u32::MAX as usize,
        "GLB total size is {total} bytes, over the glTF 32-bit container limit (4 GiB)",
    );
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(padded_json as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json);
    out.extend(std::iter::repeat_n(0x20, json_pad));
    out.extend_from_slice(&(padded_bin as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    let bin_base = out.len();
    // Zero-fill the BIN region (+ its padding); pass 2 overwrites every emitted byte.
    out.resize(total, 0);
    let pos_base = bin_base;
    let norm_base = bin_base + pos_len as usize;
    let idx_base = bin_base + (pos_len + norm_len) as usize;

    let mut cursor = 0usize;
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !mesh_visible(m, opts) {
                    continue;
                }
                let y = crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin);
                if y.indices.is_empty()
                    || y.positions.len() < 9
                    || !y.positions.len().is_multiple_of(3)
                    || y.normals.len() != y.positions.len()
                {
                    continue;
                }
                let meta = metas.get(cursor).unwrap_or_else(|| {
                    panic!("GLB streaming pass 2 saw more meshes than pass 1 ({cursor}); the mesh stream is not deterministic")
                });
                assert!(
                    meta.express_id == m.express_id
                        && meta.nverts as usize * 3 == y.positions.len()
                        && meta.nidx as usize == y.indices.len()
                        // Content-exact: an element can emit multiple submeshes
                        // with identical counts, so id+counts alone could let a
                        // reordered stream write into the wrong offsets.
                        && meta.key == geom_color_key(&y.positions, &y.normals, &y.indices, m.color),
                    "GLB streaming pass 2 diverged from pass 1 at mesh {cursor} \
                     (expected #{} {}v/{}i, got #{} {}v/{}i); the mesh stream is not deterministic",
                    meta.express_id, meta.nverts, meta.nidx,
                    m.express_id, y.positions.len() / 3, y.indices.len(),
                );
                if let Some(w) = &meta.write {
                    if let Some((center, half, small)) = &w.quant {
                        // SHORT-normalized encoding, identical to push_mesh_quantized;
                        // the 2-byte stride pads and the index-run 4-alignment pads
                        // are already zero from the container prefill.
                        let mut po = pos_base + w.pos_off as usize;
                        for p in y.positions.chunks_exact(3) {
                            for (k, &v) in p.iter().enumerate() {
                                let n = ((v as f64 - center[k]) / half[k]).clamp(-1.0, 1.0);
                                let q = (n * 32767.0).round() as i16;
                                out[po..po + 2].copy_from_slice(&q.to_le_bytes());
                                po += 2;
                            }
                            po += 2; // 8-byte stride pad
                        }
                        let mut no = norm_base + w.norm_off as usize;
                        for nrm in y.normals.chunks_exact(3) {
                            let mut v = [
                                nrm[0] as f64 * half[0],
                                nrm[1] as f64 * half[1],
                                nrm[2] as f64 * half[2],
                            ];
                            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                            if len > 0.0 {
                                v = [v[0] / len, v[1] / len, v[2] / len];
                            }
                            for c in v {
                                let q = (c.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                                out[no..no + 2].copy_from_slice(&q.to_le_bytes());
                                no += 2;
                            }
                            no += 2; // 8-byte stride pad
                        }
                        let mut io = idx_base + w.idx_off as usize;
                        if *small {
                            for &i in &y.indices {
                                out[io..io + 2].copy_from_slice(&(i as u16).to_le_bytes());
                                io += 2;
                            }
                        } else {
                            for &i in &y.indices {
                                out[io..io + 4].copy_from_slice(&i.to_le_bytes());
                                io += 4;
                            }
                        }
                    } else {
                        let mut po = pos_base + w.pos_off as usize;
                        for p in y.positions.chunks_exact(3) {
                            for (&pv, &off) in p.iter().zip(&w.vertex_offset) {
                                let baked = (pv as f64 + off) as f32;
                                out[po..po + 4].copy_from_slice(&baked.to_le_bytes());
                                po += 4;
                            }
                        }
                        let mut no = norm_base + w.norm_off as usize;
                        for &n in &y.normals {
                            out[no..no + 4].copy_from_slice(&n.to_le_bytes());
                            no += 4;
                        }
                        let mut io = idx_base + w.idx_off as usize;
                        for &i in &y.indices {
                            out[io..io + 4].copy_from_slice(&i.to_le_bytes());
                            io += 4;
                        }
                    }
                }
                cursor += 1;
            }
        },
        |_| {},
        |_| {},
    );
    assert!(
        cursor == metas.len(),
        "GLB streaming pass 2 saw {cursor} meshes, pass 1 saw {}; the mesh stream is not deterministic",
        metas.len(),
    );

    (out, stats)
}

/// Assemble a GLB from already-produced meshes (the viewer's MeshData — **no re-meshing**).
/// Per mesh `i`: `vertex_counts[i]` vertices + `index_counts[i]` indices, taken in order
/// from the concatenated `positions`/`normals`/`indices`; `colors` is RGBA per mesh,
/// `origins` is xyz per mesh, `express_ids` labels each mesh. Indices are per-mesh LOCAL.
/// Callers pass exactly the meshes they want emitted (visibility filtering is theirs).
#[allow(clippy::too_many_arguments)]
// The index `i` walks several parallel count/offset arrays in lockstep; a
// range loop is the clearest expression and avoids zipping ragged slices.
#[allow(clippy::needless_range_loop)]
pub fn export_glb_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
    express_ids: &[u32],
    include_metadata: bool,
    lit: bool,
) -> (Vec<u8>, GltfStats) {
    let n = vertex_counts.len();
    let mut views: Vec<MeshView> = Vec::with_capacity(n);
    let mut vbase = 0usize; // running vertex offset
    let mut ibase = 0usize; // running index offset
    for i in 0..n {
        let vc = vertex_counts[i] as usize;
        let ic = index_counts.get(i).copied().unwrap_or(0) as usize;
        if (vbase + vc) * 3 > positions.len() || ibase + ic > indices.len() {
            break; // malformed counts — stop rather than panic
        }
        let pslice = &positions[vbase * 3..(vbase + vc) * 3];
        let nslice: &[f32] = if normals.len() >= (vbase + vc) * 3 {
            &normals[vbase * 3..(vbase + vc) * 3]
        } else {
            &[]
        };
        let islice = &indices[ibase..ibase + ic];
        let color = [
            colors.get(i * 4).copied().unwrap_or(0.8),
            colors.get(i * 4 + 1).copied().unwrap_or(0.8),
            colors.get(i * 4 + 2).copied().unwrap_or(0.8),
            colors.get(i * 4 + 3).copied().unwrap_or(1.0),
        ];
        let origin = [
            origins.get(i * 3).copied().unwrap_or(0.0),
            origins.get(i * 3 + 1).copied().unwrap_or(0.0),
            origins.get(i * 3 + 2).copied().unwrap_or(0.0),
        ];
        views.push(MeshView {
            express_id: express_ids.get(i).copied().unwrap_or(0),
            ifc_type: "",
            global_id: None,
            positions: pslice,
            normals: nslice,
            indices: islice,
            color,
            origin,
            // The viewer's MeshData drops the instancing side-channel across the
            // worker boundary (it is `#[serde(skip)]`), so this path is always flat.
            instance: None,
        });
        vbase += vc;
        ibase += ic;
    }
    // From-meshes geometry is already absolute Y-up and never instances (no
    // side-channel), so there is no RTC frame to compensate. Quantization is a
    // from-bytes feature; the viewer path stays f32.
    let mut ch = Chunker::new(12, usize::MAX, None);
    let (gltf, stats) = build_gltf(&views, include_metadata, None, lit, [0.0, 0.0, 0.0], false, &mut ch);
    let json = serde_json::to_vec(&gltf).expect("glTF JSON serializes");
    (pack_glb(&json, &ch.embedded_bin), stats)
}

/// Pack a glTF JSON document and binary buffer into a GLB container (little-endian).
fn pack_glb(json_bytes: &[u8], bin: &[u8]) -> Vec<u8> {
    let json_pad = (4 - (json_bytes.len() % 4)) % 4;
    let bin_pad = (4 - (bin.len() % 4)) % 4;
    let padded_json = json_bytes.len() + json_pad;
    let padded_bin = bin.len() + bin_pad;

    let total = 12 + 8 + padded_json + 8 + padded_bin;
    // The GLB container total and chunk lengths are u32 (little-endian). This is
    // the authoritative 4 GiB guard: it covers the JSON chunk + 28 bytes of
    // framing + padding on top of the binary buffer, which the assemble_glb check
    // (binary buffer only) does not. Fail loud instead of wrapping into a corrupt
    // container. (Reachable only for a ~4 GiB native export; wasm32 OOMs first.)
    assert!(
        total <= u32::MAX as usize,
        "GLB total size is {total} bytes, over the glTF 32-bit container limit (4 GiB)",
    );
    let mut out = Vec::with_capacity(total);

    // GLB header
    out.extend_from_slice(b"glTF"); // magic 0x46546C67 little-endian
    out.extend_from_slice(&2u32.to_le_bytes()); // version
    out.extend_from_slice(&(total as u32).to_le_bytes());

    // JSON chunk (space-padded)
    out.extend_from_slice(&(padded_json as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(json_bytes);
    out.extend(std::iter::repeat_n(0x20, json_pad));

    // BIN chunk (zero-padded)
    out.extend_from_slice(&(padded_bin as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(bin);
    out.extend(std::iter::repeat_n(0x00, bin_pad));

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    /// Like [`fixture`] but returns `None` when the catalogued fixture has not
    /// been fetched, so the test can SKIP (never throw) per the house rule.
    fn fixture_opt(rel: &str) -> Option<Vec<u8>> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                eprintln!("skipping: fixture {rel} not fetched (run `pnpm fixtures`)");
                None
            }
        }
    }

    /// Parse a GLB and return (json: Value, bin: Vec<u8>).
    fn parse_glb(glb: &[u8]) -> (Value, Vec<u8>) {
        // Assert the literal magic bytes (not a derived constant) so a wrong magic
        // constant in pack_glb can't pass the test self-consistently.
        assert_eq!(&glb[0..4], b"glTF", "glTF magic");
        assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2, "version 2");
        let total = u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize;
        assert_eq!(total, glb.len(), "header total length matches");

        let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        assert_eq!(&glb[16..20], b"JSON", "JSON chunk tag");
        let json_start = 20;
        let json_end = json_start + json_len;
        let json: Value = serde_json::from_slice(&glb[json_start..json_end]).expect("valid JSON");

        let bin_len = u32::from_le_bytes(glb[json_end..json_end + 4].try_into().unwrap()) as usize;
        assert_eq!(&glb[json_end + 4..json_end + 8], b"BIN\0", "BIN tag");
        let bin = glb[json_end + 8..json_end + 8 + bin_len].to_vec();
        (json, bin)
    }

    #[test]
    fn with_index_glb_is_byte_identical() {
        // The shared-index path must emit byte-for-byte the same GLB as the
        // self-indexing path — it only injects an index equal to the one
        // `export_glb_with_stats` builds internally. Guards the two from drifting.
        let bytes = fixture("ara3d/duplex.ifc");
        let opts = GltfOptions::default();
        let (plain, _) = export_glb_with_stats(&bytes, &opts);
        let idx = Arc::new(crate::build_entity_index(&bytes));
        let (shared, _) = export_glb_with_stats_with_index(&bytes, &opts, idx);
        assert_eq!(plain, shared, "shared-index GLB must equal self-indexed GLB");
    }

    // ── KHR_mesh_quantization ────────────────────────────────────────────

    /// Column-major 4x4 multiply, `a * b`.
    fn mat_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
        let mut c = [0.0; 16];
        for col in 0..4 {
            for row in 0..4 {
                c[col * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum();
            }
        }
        c
    }
    fn transform_point(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
        [
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ]
    }
    /// Local transform of a glTF node from its `matrix`, or its `translation`/`scale` TRS.
    fn node_local(node: &Value) -> [f64; 16] {
        if let Some(m) = node.get("matrix").and_then(Value::as_array) {
            let mut out = [0.0; 16];
            for (i, v) in m.iter().enumerate() {
                out[i] = v.as_f64().unwrap();
            }
            return out;
        }
        let t = node.get("translation").and_then(Value::as_array);
        let s = node.get("scale").and_then(Value::as_array);
        let g = |a: Option<&Vec<Value>>, i: usize, d: f64| {
            a.and_then(|a| a.get(i)).and_then(Value::as_f64).unwrap_or(d)
        };
        [
            g(s, 0, 1.0), 0.0, 0.0, 0.0,
            0.0, g(s, 1, 1.0), 0.0, 0.0,
            0.0, 0.0, g(s, 2, 1.0), 0.0,
            g(t, 0, 0.0), g(t, 1, 0.0), g(t, 2, 0.0), 1.0,
        ]
    }
    /// Decode one POSITION accessor (f32 or normalized SHORT) to local-space points.
    fn decode_positions(json: &Value, bufs: &[&[u8]], acc_idx: usize) -> Vec<[f64; 3]> {
        let acc = &json["accessors"][acc_idx];
        let bv = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
        let bin = bufs[bv["buffer"].as_u64().unwrap() as usize];
        let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
            + acc["byteOffset"].as_u64().unwrap_or(0) as usize;
        let count = acc["count"].as_u64().unwrap() as usize;
        let ct = acc["componentType"].as_u64().unwrap();
        // Respect the declared byteStride (don't assume tight packing — the quantized
        // SHORT VEC3 attrs are padded to an 8-byte stride).
        let csz = if ct == 5126 { 4 } else { 2 };
        let stride = bv["byteStride"].as_u64().map(|s| s as usize).unwrap_or(csz * 3);
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let comp = |k: usize| -> f64 {
                let o = base + i * stride + k * csz;
                match ct {
                    5126 => f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as f64,
                    5122 => {
                        let s = i16::from_le_bytes(bin[o..o + 2].try_into().unwrap());
                        (s as f64 / 32767.0).max(-1.0) // normalized SHORT
                    }
                    other => panic!("unexpected POSITION componentType {other}"),
                }
            };
            out.push([comp(0), comp(1), comp(2)]);
        }
        out
    }
    /// World-space AABB over every mesh node, walking the scene graph (handles the
    /// quantized nested dequant child nodes via the accumulated transform).
    fn world_aabb(json: &Value, bufs: &[&[u8]]) -> ([f64; 3], [f64; 3]) {
        let nodes = json["nodes"].as_array().unwrap();
        let ident = {
            let mut m = [0.0; 16];
            m[0] = 1.0; m[5] = 1.0; m[10] = 1.0; m[15] = 1.0;
            m
        };
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let mut stack: Vec<(usize, [f64; 16])> = json["scenes"][0]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| (n.as_u64().unwrap() as usize, ident))
            .collect();
        while let Some((ni, parent)) = stack.pop() {
            let node = &nodes[ni];
            let world = mat_mul(&parent, &node_local(node));
            if let Some(mi) = node.get("mesh").and_then(Value::as_u64) {
                let acc = json["meshes"][mi as usize]["primitives"][0]["attributes"]["POSITION"]
                    .as_u64()
                    .unwrap() as usize;
                for p in decode_positions(json, bufs, acc) {
                    let w = transform_point(&world, p);
                    for k in 0..3 {
                        lo[k] = lo[k].min(w[k]);
                        hi[k] = hi[k].max(w[k]);
                    }
                }
            }
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for c in children {
                    stack.push((c.as_u64().unwrap() as usize, world));
                }
            }
        }
        (lo, hi)
    }

    #[test]
    fn quantized_glb_matches_f32_world_bounds() {
        // The quantized path reconstructs the same WORLD geometry as f32 — proves the
        // per-mesh dequant + placement (incl. the nested instanced dequant nodes)
        // compose correctly. Compared via world-space AABB within a few mm.
        let bytes = fixture("ara3d/duplex.ifc");
        let (f32_glb, _) = export_glb_with_stats(&bytes, &GltfOptions::default());
        let (q_glb, _) = export_glb_with_stats(
            &bytes,
            &GltfOptions { quantize: true, ..Default::default() },
        );
        let (j0, b0) = parse_glb(&f32_glb);
        let (j1, b1) = parse_glb(&q_glb);
        let (lo0, hi0) = world_aabb(&j0, &[&b0]);
        let (lo1, hi1) = world_aabb(&j1, &[&b1]);
        for k in 0..3 {
            assert!(
                (lo0[k] - lo1[k]).abs() < 0.01 && (hi0[k] - hi1[k]).abs() < 0.01,
                "world AABB axis {k} drifted: f32 [{},{}] vs quant [{},{}]",
                lo0[k], hi0[k], lo1[k], hi1[k]
            );
        }
    }

    // ── multi-buffer glTF ────────────────────────────────────────────────

    /// Run a streaming export and collect the buffers in index order.
    fn streaming_export(bytes: &[u8], opts: &GltfOptions, cap: usize) -> (Value, Vec<Vec<u8>>) {
        let mut buffers: Vec<Vec<u8>> = Vec::new();
        let json = export_gltf_streaming(bytes, opts, cap, |b| {
            // Buffers are flushed in order buffer0.bin, buffer1.bin, ...
            assert_eq!(b.name, format!("buffer{}.bin", buffers.len()));
            buffers.push(b.bytes);
        });
        (serde_json::from_slice(&json).unwrap(), buffers)
    }

    #[test]
    fn multibuffer_splits_and_matches_single_glb() {
        // A tiny cap forces the geometry across several < cap buffers; the reconstructed
        // world geometry must equal the single-GLB output exactly (f32, same bytes, just
        // split). Proves the chunked bufferView/accessor reindexing is correct.
        let bytes = fixture("ara3d/duplex.ifc");
        let opts = GltfOptions::default();
        let (glb, _) = export_glb_with_stats(&bytes, &opts);
        let (gj, gb) = parse_glb(&glb);
        let (lo0, hi0) = world_aabb(&gj, &[&gb]);

        // Above duplex's largest single mesh (~67 KB) so the cap is respected, but small
        // enough to force a multi-buffer split. (A single mesh over the cap legitimately
        // gets its own over-cap buffer — geometry can't span buffers.)
        let cap = 256 * 1024;
        let (j, bufs) = streaming_export(&bytes, &opts, cap);
        assert!(bufs.len() >= 2, "cap must split; got {} buffers", bufs.len());
        for b in &bufs {
            assert!(b.len() <= cap, "buffer {} exceeds cap {cap}", b.len());
        }
        // The .gltf declares one buffer per chunk, each with an external uri.
        let decl = j["buffers"].as_array().unwrap();
        assert_eq!(decl.len(), bufs.len());
        for (k, b) in decl.iter().enumerate() {
            assert_eq!(b["uri"], Value::String(format!("buffer{k}.bin")));
            assert_eq!(b["byteLength"].as_u64().unwrap() as usize, bufs[k].len());
        }
        let refs: Vec<&[u8]> = bufs.iter().map(Vec::as_slice).collect();
        let (lo1, hi1) = world_aabb(&j, &refs);
        for k in 0..3 {
            assert!(
                (lo0[k] - lo1[k]).abs() < 1e-4 && (hi0[k] - hi1[k]).abs() < 1e-4,
                "multi-buffer world AABB axis {k} drifted from single GLB"
            );
        }
    }

    #[test]
    fn multibuffer_quantized_roundtrips() {
        // Quantization + multi-buffer compose: quantized geometry split across chunks
        // still reconstructs the f32 world bounds (within mm) and stays < cap.
        let bytes = fixture("ara3d/duplex.ifc");
        let (glb, _) = export_glb_with_stats(&bytes, &GltfOptions::default());
        let (gj, gb) = parse_glb(&glb);
        let (lo0, hi0) = world_aabb(&gj, &[&gb]);

        let cap = 64 * 1024;
        let (j, bufs) = streaming_export(&bytes, &GltfOptions { quantize: true, ..Default::default() }, cap);
        assert!(bufs.len() >= 2);
        assert!(j["extensionsRequired"].as_array().unwrap().iter().any(|e| e == "KHR_mesh_quantization"));
        let refs: Vec<&[u8]> = bufs.iter().map(Vec::as_slice).collect();
        let (lo1, hi1) = world_aabb(&j, &refs);
        for k in 0..3 {
            assert!((lo0[k] - lo1[k]).abs() < 0.01 && (hi0[k] - hi1[k]).abs() < 0.01);
        }
    }

    #[test]
    fn quantized_normal_compensation_survives_nonuniform_scale() {
        // The bug Greptile caught: a normal stored raw is distorted by the node's
        // non-uniform dequant scale. Verify the compensation — store `normalize(half⊙N)`,
        // and after the renderer applies `S(1/half)` (inverse-transpose of the node
        // scale) the rendered direction is the original N. Includes the 10×10×0.3 m slab.
        let cases: [([f64; 3], [f64; 3]); 3] = [
            ([5.0, 5.0, 0.15], [0.70710678, 0.0, 0.70710678]), // slab, 45° face
            ([5.0, 5.0, 0.15], [0.0, 0.0, 1.0]),               // axis-aligned (already ok)
            ([3.0, 0.2, 7.0], [0.3, 0.5, 0.81]),               // arbitrary beam-ish
        ];
        for (half, n_in) in cases {
            // normalize input
            let l = (n_in[0] * n_in[0] + n_in[1] * n_in[1] + n_in[2] * n_in[2]).sqrt();
            let n = [n_in[0] / l, n_in[1] / l, n_in[2] / l];
            // stored = normalize(half ⊙ N)  (what push_mesh_quantized writes)
            let mut s = [n[0] * half[0], n[1] * half[1], n[2] * half[2]];
            let sl = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
            s = [s[0] / sl, s[1] / sl, s[2] / sl];
            // rendered = normalize(S(1/half) · stored)  (renderer's normal-matrix step)
            let mut r = [s[0] / half[0], s[1] / half[1], s[2] / half[2]];
            let rl = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
            r = [r[0] / rl, r[1] / rl, r[2] / rl];
            for k in 0..3 {
                assert!(
                    (r[k] - n[k]).abs() < 1e-6,
                    "normal {n:?} under half {half:?} rendered {r:?}, not the original"
                );
            }
        }
    }

    #[test]
    fn multibuffer_is_deterministic() {
        let bytes = fixture("ara3d/duplex.ifc");
        let opts = GltfOptions::default();
        let (j1, b1) = streaming_export(&bytes, &opts, 64 * 1024);
        let (j2, b2) = streaming_export(&bytes, &opts, 64 * 1024);
        assert_eq!(j1, j2, "multi-buffer JSON must be deterministic");
        assert_eq!(b1, b2, "multi-buffer .bin set must be deterministic");
    }

    #[test]
    fn quantized_glb_is_structurally_valid() {
        let bytes = fixture("ara3d/duplex.ifc");
        let (glb, stats) = export_glb_with_stats(
            &bytes,
            &GltfOptions { quantize: true, ..Default::default() },
        );
        let (json, bin) = parse_glb(&glb);
        assert!(stats.meshes > 0);
        // Extension declared and required.
        let req = json["extensionsRequired"].as_array().expect("extensionsRequired");
        assert!(req.iter().any(|e| e == "KHR_mesh_quantization"));
        // Positions/normals are normalized SHORT; indices are u16 or u32.
        for acc in json["accessors"].as_array().unwrap() {
            let ct = acc["componentType"].as_u64().unwrap();
            if acc["type"] == "VEC3" {
                assert_eq!(ct, 5122, "VEC3 attrs must be SHORT when quantized");
                assert_eq!(acc["normalized"], Value::Bool(true));
            } else {
                assert!(ct == 5123 || ct == 5125, "indices must be u16/u32, got {ct}");
            }
        }
        // Vertex-attribute bufferViews must declare a byteStride that is a multiple of 4
        // (glTF requirement for a bufferView shared by multiple accessors). SHORT VEC3 is
        // padded to 8.
        for bv in json["bufferViews"].as_array().unwrap() {
            if let Some(stride) = bv["byteStride"].as_u64() {
                assert_eq!(stride, 8, "quantized SHORT VEC3 stride must be 8");
                assert!(stride % 4 == 0, "byteStride must be a multiple of 4");
            }
        }
        // Every accessor fits its bufferView (component sizes incl. the quantized types).
        let comp_size = |ct: u64| match ct {
            5126 | 5125 => 4,
            5122 | 5123 => 2,
            5120 | 5121 => 1,
            other => panic!("size for {other}"),
        };
        let n_per = |t: &str| if t == "VEC3" { 3 } else { 1 };
        for acc in json["accessors"].as_array().unwrap() {
            let bv = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
            let end = acc["byteOffset"].as_u64().unwrap_or(0)
                + acc["count"].as_u64().unwrap()
                    * n_per(acc["type"].as_str().unwrap())
                    * comp_size(acc["componentType"].as_u64().unwrap());
            assert!(end <= bv["byteLength"].as_u64().unwrap(), "accessor overruns bufferView");
        }
        assert_eq!(bin.len() as u64, json["buffers"][0]["byteLength"].as_u64().unwrap());
    }

    #[test]
    fn quantized_glb_is_byte_deterministic() {
        let bytes = fixture("ara3d/duplex.ifc");
        let opts = GltfOptions { quantize: true, ..Default::default() };
        let (a, _) = export_glb_with_stats(&bytes, &opts);
        let (b, _) = export_glb_with_stats(&bytes, &opts);
        assert_eq!(a, b, "quantized GLB must be byte-deterministic");
    }

    #[test]
    fn quantization_roundtrip_precision() {
        // Per-mesh 16-bit quantize -> dequantize keeps error within one bin (extent /
        // 65534 per axis). Synthetic 10 m mesh: error must be well under a mm.
        let mut pos = Vec::new();
        for i in 0..200u32 {
            let t = i as f32 / 199.0;
            pos.extend_from_slice(&[t * 10.0, t * 3.0, 5.0 - t * 5.0]);
        }
        let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for p in pos.chunks_exact(3) {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k] as f64);
                hi[k] = hi[k].max(p[k] as f64);
            }
        }
        let center: Vec<f64> = (0..3).map(|k| (lo[k] + hi[k]) * 0.5).collect();
        let half: Vec<f64> = (0..3).map(|k| ((hi[k] - lo[k]) * 0.5).max(f64::MIN_POSITIVE)).collect();
        let mut worst = 0.0f64;
        for p in pos.chunks_exact(3) {
            for k in 0..3 {
                let n = ((p[k] as f64 - center[k]) / half[k]).clamp(-1.0, 1.0);
                let q = (n * 32767.0).round();
                let deq = q / 32767.0 * half[k] + center[k];
                worst = worst.max((deq - p[k] as f64).abs());
            }
        }
        assert!(worst < 0.001, "per-axis quant error {worst} m exceeds 1 mm on a 10 m mesh");
    }

    #[test]
    fn duplex_exports_valid_glb() {
        let (glb, stats) =
            export_glb_with_stats(&fixture("ara3d/duplex.ifc"), &GltfOptions::default());
        assert!(stats.meshes > 0 && stats.triangles > 0);

        let (json, bin) = parse_glb(&glb);
        assert_eq!(json["asset"]["version"], "2.0");
        assert_eq!(json["asset"]["generator"], "IFC-Lite");
        assert_eq!(json["scene"], 0);

        let nodes = json["nodes"].as_array().unwrap();
        let meshes = json["meshes"].as_array().unwrap();
        // Instancing: one node per element OCCURRENCE + a single root that parents
        // them all. `meshes` is the DEDUPED unique-geometry count (repeated shapes
        // share one mesh), so meshes <= occurrences and json meshes == stats.meshes.
        let occurrences = nodes.len() - 1;
        assert_eq!(meshes.len(), stats.meshes, "json meshes == deduped mesh count");
        assert!(stats.meshes <= occurrences, "unique meshes <= occurrences");

        // Scene has exactly one top-level node: the root. It carries the model
        // centre translation and parents every occurrence node.
        let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
        assert_eq!(scene_nodes.len(), 1, "single root node");
        let root_idx = scene_nodes[0].as_u64().unwrap() as usize;
        let root = &nodes[root_idx];
        assert!(root.get("mesh").is_none(), "root is a transform node, no mesh");
        assert_eq!(
            root["children"].as_array().unwrap().len(),
            occurrences,
            "root parents every occurrence node"
        );
        // Every non-root node references a mesh. An element node is one of:
        //   - flat singleton: placement baked into vertices, no transform;
        //   - flat content-hash share: a node TRANSLATION places the shared mesh;
        //   - rep-instanced: a node MATRIX places the shared template.
        // glTF forbids both `matrix` and `translation` on one node — assert that.
        let mut instanced_nodes = 0usize;
        for (i, n) in nodes.iter().enumerate() {
            if i != root_idx {
                assert!(n["mesh"].is_number(), "element nodes reference a mesh");
                assert!(
                    !(n.get("matrix").is_some() && n.get("translation").is_some()),
                    "a node never carries both matrix and translation"
                );
                if let Some(m) = n.get("matrix") {
                    assert_eq!(m.as_array().unwrap().len(), 16, "node matrix is a 4x4");
                    instanced_nodes += 1;
                }
            }
        }
        // duplex repeats geometry, so instancing must have fired: fewer unique meshes
        // than occurrences AND at least one occurrence placed via a node matrix.
        assert!(stats.meshes < occurrences, "duplex repeats geometry -> dedup fired");
        assert!(instanced_nodes > 0, "shared templates are placed via node matrix");

        // Materials present + LIT by default (#1321: no KHR_materials_unlit) +
        // double-sided.
        assert!(!json["materials"].as_array().unwrap().is_empty());
        assert!(
            json.get("extensionsUsed").is_none(),
            "lit by default: no extensionsUsed / unlit extension"
        );
        assert!(
            json["materials"].as_array().unwrap().iter().all(|m| m.get("extensions").is_none()),
            "lit materials carry no extensions"
        );
        assert!(
            json["materials"].as_array().unwrap().iter().all(|m| m["doubleSided"] == true),
            "materials double-sided (IFC winding isn't reliably outward)"
        );

        // Every accessor must fit inside its bufferView (validator-critical).
        let bvs = json["bufferViews"].as_array().unwrap();
        for acc in json["accessors"].as_array().unwrap() {
            let bv = &bvs[acc["bufferView"].as_u64().unwrap() as usize];
            let comp = match acc["componentType"].as_u64().unwrap() {
                5126 | 5125 => 4,
                5123 => 2,
                other => panic!("unexpected componentType {other}"),
            };
            let per = match acc["type"].as_str().unwrap() {
                "VEC3" => 3,
                "SCALAR" => 1,
                other => panic!("unexpected type {other}"),
            };
            let len = acc["count"].as_u64().unwrap() * per * comp;
            let end = acc["byteOffset"].as_u64().unwrap() + len;
            assert!(end <= bv["byteLength"].as_u64().unwrap(), "accessor overruns bufferView");
        }

        // Binary buffer length matches the declared buffer.
        assert_eq!(bin.len(), json["buffers"][0]["byteLength"].as_u64().unwrap() as usize);
    }

    #[test]
    fn from_meshes_assembles_valid_glb() {
        // Two meshes (a quad each) supplied as already-produced buffers — no re-meshing.
        // Mesh 0: unit quad at origin; Mesh 1: same quad with a non-zero RTC origin.
        let positions: Vec<f32> = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // mesh 0
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // mesh 1
        ];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 8).flatten().collect();
        let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3];
        let vertex_counts = vec![4u32, 4];
        let index_counts = vec![6u32, 6];
        let colors = vec![1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.5]; // red opaque, green translucent
        let origins = vec![0.0, 0.0, 0.0, 1000.0, 2000.0, 3000.0]; // mesh 1 has RTC offset
        let express_ids = vec![10u32, 20];

        let (glb, stats) = export_glb_from_meshes(
            &positions, &normals, &indices, &vertex_counts, &index_counts, &colors, &origins,
            &express_ids, true, true,
        );
        assert_eq!(stats.meshes, 2);
        assert_eq!(stats.triangles, 4);
        assert_eq!(stats.materials, 2, "two distinct colors → two materials");

        let (json, bin) = parse_glb(&glb);
        assert_eq!(json["asset"]["generator"], "IFC-Lite");
        let nodes = json["nodes"].as_array().unwrap();
        // 2 element nodes + 1 root.
        assert_eq!(nodes.len(), 3);

        // Exactly ONE node carries a translation — the single root. Per-element
        // node.translation (the "all centre aligned" failure mode) is gone.
        let translated: Vec<&Value> =
            nodes.iter().filter(|n| n.get("translation").is_some()).collect();
        assert_eq!(translated.len(), 1, "only the root node is translated");
        let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
        assert_eq!(scene_nodes.len(), 1);
        let root = &nodes[scene_nodes[0].as_u64().unwrap() as usize];
        let root_t = root["translation"].as_array().unwrap();
        let center = [
            root_t[0].as_f64().unwrap(),
            root_t[1].as_f64().unwrap(),
            root_t[2].as_f64().unwrap(),
        ];

        // SELF-CONTAINED placement: the two quads are ~3000 apart in mesh 1's farthest
        // axis. Their baked (translation-dropped) accessor bounds must preserve that
        // separation — i.e. dropping the root translation does NOT collapse them onto
        // each other (which is exactly what per-element node.translation did wrong).
        let accs = json["accessors"].as_array().unwrap();
        let mut bmin = [f64::INFINITY; 3];
        let mut bmax = [f64::NEG_INFINITY; 3];
        for mesh in json["meshes"].as_array().unwrap() {
            let pa = mesh["primitives"][0]["attributes"]["POSITION"].as_u64().unwrap() as usize;
            for k in 0..3 {
                let lo = accs[pa]["min"][k].as_f64().unwrap();
                let hi = accs[pa]["max"][k].as_f64().unwrap();
                if lo < bmin[k] { bmin[k] = lo; }
                if hi > bmax[k] { bmax[k] = hi; }
            }
        }
        assert!(
            (bmax[2] - bmin[2]) > 2999.0,
            "baked geometry retains the ~3000 element separation (no centre-collapse): got {}",
            bmax[2] - bmin[2]
        );

        // World reconstruction: root.translation + baked bounds recover the true AABB
        // (~[0,0,0]..[1001,2001,3000]).
        for k in 0..3 {
            let wmax = center[k] + bmax[k];
            let wmin = center[k] + bmin[k];
            assert!(wmin.abs() < 1.0, "world min ~0 on axis {k}: {wmin}");
            let expect = [1001.0, 2001.0, 3000.0][k];
            assert!((wmax - expect).abs() < 1.0, "world max ~{expect} on axis {k}: {wmax}");
        }

        // Translucent material → BLEND.
        assert!(json["materials"].as_array().unwrap().iter().any(|m| m["alphaMode"] == "BLEND"));
        assert_eq!(bin.len(), json["buffers"][0]["byteLength"].as_u64().unwrap() as usize);

        // Lit (the call above passed lit = true): no unlit extension anywhere.
        assert!(json.get("extensionsUsed").is_none(), "lit export omits extensionsUsed");
        assert!(
            json["materials"].as_array().unwrap().iter().all(|m| m.get("extensions").is_none()),
            "lit materials carry no extensions"
        );
    }

    #[test]
    fn export_is_byte_deterministic() {
        // Instancing groups by HashMap keys (rep colour buckets, material dedup);
        // emission order must be fixed so repeated exports are byte-identical.
        let content = fixture("ara3d/C20-Institute-Var-2.ifc");
        let a = export_glb(&content, &GltfOptions { include_metadata: true, ..Default::default() });
        let b = export_glb(&content, &GltfOptions { include_metadata: true, ..Default::default() });
        assert_eq!(a, b, "repeated GLB exports must be byte-identical");
    }

    #[test]
    fn nodes_carry_global_id_and_model_id() {
        // From-bytes export with metadata + a model id: every element node carries
        // `modelId`, and elements with an IFC GlobalId carry `GlobalId`.
        let content = fixture("ara3d/duplex.ifc");
        let opts = GltfOptions {
            include_metadata: true,
            model_id: Some("model-42".to_string()),
            ..GltfOptions::default()
        };
        let (glb, _stats) = export_glb_with_stats(&content, &opts);
        let (json, _bin) = parse_glb(&glb);
        let nodes = json["nodes"].as_array().unwrap();

        let mut saw_global = false;
        let mut element_nodes = 0;
        for n in nodes {
            let Some(extras) = n.get("extras") else { continue };
            if extras.get("expressId").is_none() {
                continue; // structural node (e.g. root), not an element
            }
            element_nodes += 1;
            assert_eq!(
                extras["modelId"].as_str(),
                Some("model-42"),
                "every element node carries the model id"
            );
            if let Some(g) = extras.get("GlobalId").and_then(|v| v.as_str()) {
                assert!(!g.is_empty(), "GlobalId is non-empty when present");
                saw_global = true;
            }
        }
        assert!(element_nodes > 0, "expected element nodes with metadata");
        assert!(saw_global, "at least one node carries an IFC GlobalId");

        // Without a model id, no `modelId` key is emitted.
        let plain = GltfOptions { include_metadata: true, ..GltfOptions::default() };
        let (glb2, _) = export_glb_with_stats(&content, &plain);
        let (json2, _) = parse_glb(&glb2);
        for n in json2["nodes"].as_array().unwrap() {
            if let Some(extras) = n.get("extras") {
                assert!(extras.get("modelId").is_none(), "no modelId without a model id");
            }
        }
    }

    /// #1496 regression — the join contract: every meshed GLB node's `expressId`
    /// must resolve to an export-model row, so a viewer can always look up
    /// attributes on pick. The whole legacy-entity class (`IfcProxy`,
    /// `IfcSolidStratum`, and the common IFC2x3 `*StandardCase`/`*ElementedCase`
    /// entities) used to render *without* a row: the geometry pass meshes them via
    /// the legacy table, but the attribute pass tested a bare `from_str`
    /// (→ `Unknown`) against `IfcProduct`. Both now use `legacy_aware_ifc_type`.
    /// These fixtures cover the proxy + geoscience cases; the mechanism generalises
    /// to every legacy product. (Type-only geometry — `IfcBoilerType` in the
    /// tessellation-with-*-texture fixtures — is a separate, harder case tracked as
    /// a follow-up and intentionally NOT covered here.)
    #[test]
    fn glb_nodes_have_export_rows_for_legacy_products() {
        let mut found = 0;
        for rel in [
            "ifcopenshell/1030-sphere.ifc",
            "ifcopenshell/1032-curve.ifc",
            "issues/860_solid_stratum.ifc",
        ] {
            let Some(content) = fixture_opt(rel) else { continue };
            found += 1;
            let opts = GltfOptions {
                include_metadata: true,
                ..GltfOptions::default()
            };
            let (glb, _stats) = export_glb_with_stats(&content, &opts);
            let (json, _bin) = parse_glb(&glb);
            let rows: std::collections::HashSet<u32> = crate::model::build_export_model(&content)
                .entities
                .iter()
                .map(|e| e.express_id)
                .collect();
            let mut checked = 0;
            for n in json["nodes"].as_array().unwrap() {
                let Some(extras) = n.get("extras") else { continue };
                let Some(eid) = extras.get("expressId").and_then(|v| v.as_u64()) else {
                    continue;
                };
                checked += 1;
                assert!(
                    rows.contains(&(eid as u32)),
                    "{rel}: GLB node expressId {eid} (ifcType {:?}) has no export-model row (#1496)",
                    extras.get("ifcType")
                );
            }
            assert!(checked > 0, "{rel}: expected at least one meshed element node");
        }
        // Per the fixture_opt house rule the test is green when the corpus isn't
        // fetched — but say so, so a silent zero-coverage run (Greptile #1511) is
        // visible rather than masquerading as a real pass. CI fetches the corpus,
        // so `found` is 3 there and the join contract is actually exercised.
        if found == 0 {
            eprintln!(
                "skipping glb_nodes_have_export_rows: no legacy fixtures fetched \
                 (run `pnpm fixtures`)"
            );
        }
    }

    #[test]
    fn occurrence_matrix_reconstructs_rotated_instance_under_national_grid_rtc() {
        // Decisive synthetic test for the RTC/rotation frame (review finding C1+M1):
        // a ROTATED occurrence at NATIONAL-GRID coordinates. The node matrix is built
        // from the same InstanceMeta the baker would carry; reconstructing the
        // occurrence from the template's baked-local geometry must land on the
        // occurrence's own baked geometry to sub-millimetre, even though the relative
        // transform's absolute terms are ~1e5 m. (A pre-RTC `rel` applied to post-RTC
        // geometry — the bug — misplaces this by ~(R-I)·rtc, i.e. hundreds of metres.)
        use ifc_lite_geometry::InstanceMeta;

        // Row-major helpers.
        let translate = |t: [f64; 3]| -> [f64; 16] {
            [1., 0., 0., t[0], 0., 1., 0., t[1], 0., 0., 1., t[2], 0., 0., 0., 1.]
        };
        // Rotation about Z (Z-up): (x,y) rotate, z fixed.
        let rot_z = |deg: f64| -> [f64; 16] {
            let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
            [c, -s, 0., 0., s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
        };
        let apply = |m: &[f64; 16], p: [f64; 3]| -> [f64; 3] {
            [
                m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
                m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
                m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
            ]
        };

        // Placements (Z-up, pre-RTC): template upright, occurrence rotated 37° about Z.
        let m_ref = super::mat4_mul(&translate([10., 20., 5.]), &rot_z(0.0));
        let m_k = super::mat4_mul(&translate([60., 35., 5.]), &rot_z(37.0));
        // National-grid RTC the baker subtracts (e.g. Dutch RD-ish easting/northing).
        let rtc = [155_000.0_f64, 463_000.0, 0.0];

        // Canonical (rep-local) geometry — a few non-degenerate points.
        let canonical = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.5, 0.5, 1.5],
            [2.0, 0.3, 0.7],
        ];
        // Baked = placement·canonical - rtc, in Z-up.
        let bake = |m: &[f64; 16]| -> Vec<[f64; 3]> {
            canonical
                .iter()
                .map(|&x| {
                    let w = apply(m, x);
                    [w[0] - rtc[0], w[1] - rtc[1], w[2] - rtc[2]]
                })
                .collect()
        };
        let tmpl_baked = bake(&m_ref);
        let occ_baked = bake(&m_k);

        // Template origin = centroid of its baked geometry; local = baked - origin.
        let n = canonical.len() as f64;
        let origin_z = {
            let mut o = [0.0; 3];
            for p in &tmpl_baked {
                for k in 0..3 {
                    o[k] += p[k] / n;
                }
            }
            o
        };
        // Convert template origin + local, and the occurrence's baked truth, to Y-up.
        let origin_yup = crate::frame::yup_f64(origin_z);
        let tmpl_local_yup: Vec<[f64; 3]> = tmpl_baked
            .iter()
            .map(|p| crate::frame::yup_f64([p[0] - origin_z[0], p[1] - origin_z[1], p[2] - origin_z[2]]))
            .collect();
        let occ_world_yup: Vec<[f64; 3]> = occ_baked.iter().map(|p| crate::frame::yup_f64(*p)).collect();

        // scene_center = centre of the combined baked Y-up AABB.
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in tmpl_baked.iter().chain(occ_baked.iter()) {
            let y = crate::frame::yup_f64(*p);
            for k in 0..3 {
                lo[k] = lo[k].min(y[k]);
                hi[k] = hi[k].max(y[k]);
            }
        }
        let scene_center = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5];

        let meta = |transform: [f64; 16]| InstanceMeta {
            transform,
            local_transform: None,
            canonical_transform: None,
            rep_identity: 42,
            instanceable: true,
        };
        let m_ref_inv = super::affine_inverse(&super::compose_world_meta(&meta(m_ref)))
            .expect("template placement invertible");
        let node = super::occurrence_node_matrix(&meta(m_k), &m_ref_inv, rtc, origin_yup, scene_center);

        // Reconstruct: world = scene_center(root) + node(col-major) · template_local.
        let mut max_err = 0.0f64;
        for (lv, truth) in tmpl_local_yup.iter().zip(&occ_world_yup) {
            let (x, y, z) = (lv[0], lv[1], lv[2]);
            let world = [
                scene_center[0] + node[0] as f64 * x + node[4] as f64 * y + node[8] as f64 * z + node[12] as f64,
                scene_center[1] + node[1] as f64 * x + node[5] as f64 * y + node[9] as f64 * z + node[13] as f64,
                scene_center[2] + node[2] as f64 * x + node[6] as f64 * y + node[10] as f64 * z + node[14] as f64,
            ];
            for k in 0..3 {
                max_err = max_err.max((world[k] - truth[k]).abs());
            }
        }
        assert!(
            max_err < 1e-3,
            "rotated instance under national-grid RTC mis-reconstructed by {max_err} m"
        );
    }

    #[test]
    fn instanced_occurrences_reconstruct_world_positions() {
        // Decisive precision round-trip on a REAL repetitive model: every instanced
        // occurrence must reconstruct its true baked world geometry via
        //   world = root.translation + node.matrix · template_local_vertex
        // matching `process_geometry`'s per-occurrence baked Y-up world (origin +
        // position). This exercises the full chain — rep-identity grouping, the
        // Z-up→Y-up conjugation, scene-center folding, and the f32 node matrix — on
        // genuinely rotated, placed occurrences, so any frame/RTC error surfaces.
        let content = fixture("ara3d/C20-Institute-Var-2.ifc");
        let opts = GltfOptions { include_metadata: true, ..GltfOptions::default() };
        let (glb, _stats) = export_glb_with_stats(&content, &opts);
        let (json, bin) = parse_glb(&glb);

        // Truth: express id -> the occurrence's baked Y-up world vertices.
        let result = process_geometry(&content[..]);
        let default_opts = GltfOptions::default();
        let mut truth: HashMap<u32, Vec<[f64; 3]>> = HashMap::new();
        let mut dup_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for m in &result.meshes {
            if !super::mesh_visible(m, &default_opts) || m.positions.len() < 9 {
                continue;
            }
            let y = crate::frame::to_yup(&m.positions, &m.normals, &m.indices, m.origin);
            let verts: Vec<[f64; 3]> = y
                .positions
                .chunks_exact(3)
                .map(|c| {
                    [
                        c[0] as f64 + y.origin[0],
                        c[1] as f64 + y.origin[1],
                        c[2] as f64 + y.origin[2],
                    ]
                })
                .collect();
            // An express id with >1 visible mesh (submeshes) is ambiguous to match
            // 1:1 against a single template, so exclude it from the check.
            if truth.insert(m.express_id, verts).is_some() {
                dup_ids.insert(m.express_id);
            }
        }

        let nodes = json["nodes"].as_array().unwrap();
        let accs = json["accessors"].as_array().unwrap();
        let bviews = json["bufferViews"].as_array().unwrap();
        let meshes_j = json["meshes"].as_array().unwrap();
        let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
        let root = &nodes[scene_nodes[0].as_u64().unwrap() as usize];
        let root_t = root
            .get("translation")
            .map(|v| {
                let a = v.as_array().unwrap();
                [a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap()]
            })
            .unwrap_or([0.0; 3]);

        // Read a mesh's POSITION accessor floats straight out of the BIN chunk.
        let read_positions = |mesh_idx: usize| -> Vec<[f32; 3]> {
            let pa = meshes_j[mesh_idx]["primitives"][0]["attributes"]["POSITION"]
                .as_u64()
                .unwrap() as usize;
            let acc = &accs[pa];
            let count = acc["count"].as_u64().unwrap() as usize;
            let bv = &bviews[acc["bufferView"].as_u64().unwrap() as usize];
            let base = bv["byteOffset"].as_u64().unwrap() as usize
                + acc["byteOffset"].as_u64().unwrap() as usize;
            (0..count)
                .map(|i| {
                    let o = base + i * 12;
                    [
                        f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()),
                        f32::from_le_bytes(bin[o + 4..o + 8].try_into().unwrap()),
                        f32::from_le_bytes(bin[o + 8..o + 12].try_into().unwrap()),
                    ]
                })
                .collect()
        };

        let mut checked = 0usize;
        let mut max_err = 0.0f64;
        for child in root["children"].as_array().unwrap() {
            let node = &nodes[child.as_u64().unwrap() as usize];
            // Instanced occurrences carry a node matrix; flat ones do not.
            let Some(mv) = node.get("matrix") else { continue };
            let express = node["extras"]["expressId"].as_u64().unwrap() as u32;
            if dup_ids.contains(&express) {
                continue;
            }
            let Some(truth_verts) = truth.get(&express) else { continue };
            let locals = read_positions(node["mesh"].as_u64().unwrap() as usize);
            if locals.len() != truth_verts.len() {
                continue;
            }
            // Column-major 4x4: element (row r, col c) = m[c*4 + r].
            let m: Vec<f64> = mv.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
            for (lv, t) in locals.iter().zip(truth_verts) {
                let (lx, ly, lz) = (lv[0] as f64, lv[1] as f64, lv[2] as f64);
                let world = [
                    root_t[0] + m[0] * lx + m[4] * ly + m[8] * lz + m[12],
                    root_t[1] + m[1] * lx + m[5] * ly + m[9] * lz + m[13],
                    root_t[2] + m[2] * lx + m[6] * ly + m[10] * lz + m[14],
                ];
                for k in 0..3 {
                    max_err = max_err.max((world[k] - t[k]).abs());
                }
            }
            checked += 1;
        }
        assert!(checked > 50, "expected many instanced occurrences to verify, got {checked}");
        // f32 vertex/matrix precision at building scale: well under a millimetre.
        assert!(max_err < 1e-3, "instanced world reconstruction error {max_err} m too large");
    }

    #[test]
    fn unlit_option_emits_khr_materials_unlit() {
        // #1321: lit = false reproduces the historical flat material — every
        // material tagged KHR_materials_unlit and the extension declared globally.
        let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 4).flatten().collect();
        let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
        let (glb, _) = export_glb_from_meshes(
            &positions,
            &normals,
            &indices,
            &[4],
            &[6],
            &[0.5, 0.5, 0.5, 1.0],
            &[0.0, 0.0, 0.0],
            &[10],
            false,
            false, // lit = false ⇒ unlit
        );
        let (json, _) = parse_glb(&glb);
        assert_eq!(json["extensionsUsed"][0], "KHR_materials_unlit");
        assert!(
            json["materials"].as_array().unwrap().iter().all(|m| m["extensions"]
                ["KHR_materials_unlit"]
                .is_object()),
            "unlit materials carry the KHR_materials_unlit extension"
        );
    }

    #[test]
    fn metadata_and_isolation() {
        let with_meta = export_glb_with_stats(
            &fixture("ara3d/duplex.ifc"),
            &GltfOptions { include_metadata: true, ..GltfOptions::default() },
        )
        .0;
        let (json, _) = parse_glb(&with_meta);
        assert!(json["asset"]["extras"]["meshCount"].as_u64().unwrap() >= 1);
        assert!(json["nodes"][0]["extras"]["expressId"].is_number());

        // Isolate one id ⇒ fewer or equal meshes than the full export.
        let full = export_glb_with_stats(&fixture("ara3d/duplex.ifc"), &GltfOptions::default()).1;
        let some_id = process_geometry(&fixture("ara3d/duplex.ifc")[..])
            .meshes
            .iter()
            .find(|m| super::mesh_visible(m, &GltfOptions::default()))
            .map(|m| m.express_id)
            .unwrap();
        let iso = export_glb_with_stats(
            &fixture("ara3d/duplex.ifc"),
            &GltfOptions { isolated: vec![some_id], ..GltfOptions::default() },
        )
        .1;
        assert!(iso.meshes >= 1 && iso.meshes <= full.meshes);
    }

    /// A structurally valid IFC with zero products (no render geometry).
    const GEOMETRYLESS_IFC: &str = "ISO-10303-21;\n\
HEADER;\n\
FILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('empty.ifc','2026-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('0000000000000000000001',$,'Empty',$,$,$,$,$,#2);\n\
#2=IFCUNITASSIGNMENT((#3));\n\
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
ENDSEC;\n\
END-ISO-10303-21;\n";

    #[test]
    fn try_export_glb_fails_closed_on_geometryless_model() {
        let err = try_export_glb(GEOMETRYLESS_IFC.as_bytes(), &GltfOptions::default())
            .expect_err("a zero-mesh export must be an error, not a valid empty GLB");
        assert_eq!(err, ExportError::NoRenderGeometry);
        assert_eq!(err.code(), "NO_RENDER_GEOMETRY");
        // The fail-open path still exists for callers that explicitly want it.
        let (glb, stats) = export_glb_with_stats(GEOMETRYLESS_IFC.as_bytes(), &GltfOptions::default());
        assert_eq!(stats.meshes, 0);
        let (json, _) = parse_glb(&glb);
        assert!(json["meshes"].as_array().is_none_or(|m| m.is_empty()));
    }

    #[test]
    fn try_export_glb_matches_fail_open_path_when_nonempty() {
        let Some(content) = fixture_opt("ifcopenshell/1019-column.ifc") else { return };
        let (glb, stats) =
            try_export_glb_with_stats(&content, &GltfOptions::default()).expect("has geometry");
        assert!(stats.meshes >= 1);
        let (baseline, _) = export_glb_with_stats(&content, &GltfOptions::default());
        assert_eq!(glb, baseline, "try_ path must be byte-identical to export_glb");
    }

    /// Sum of world triangles: every node instance of a mesh counts its index
    /// accessor, so dedup/instancing differences between assemblers cancel out.
    fn world_triangles(json: &Value) -> u64 {
        let empty = vec![];
        let nodes = json["nodes"].as_array().unwrap_or(&empty);
        let mut tris = 0u64;
        for node in nodes {
            let Some(mi) = node["mesh"].as_u64() else { continue };
            let prim = &json["meshes"][mi as usize]["primitives"][0];
            let ai = prim["indices"].as_u64().expect("indices accessor") as usize;
            tris += json["accessors"][ai]["count"].as_u64().expect("count") / 3;
        }
        tris
    }

    #[test]
    fn streaming_bounded_is_byte_identical_on_flat_models() {
        // Models with no instanceable groups exercise exactly the code the two
        // assemblers share (flat emission + content dedup); their output must be
        // byte-for-byte identical, JSON and BIN.
        for rel in ["ifcopenshell/1019-column.ifc", "ifcopenshell/1030-sphere.ifc"] {
            let Some(content) = fixture_opt(rel) else { continue };
            let opts = GltfOptions { include_metadata: true, ..GltfOptions::default() };
            let (in_memory, mem_stats) = export_glb_from_result(process_geometry(&content), &opts);
            let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
            assert_eq!(mem_stats.meshes, stream_stats.meshes, "{rel}: mesh stats");
            assert_eq!(in_memory, streamed, "{rel}: bounded assembler must be byte-identical");
        }
    }

    #[test]
    fn streaming_bounded_preserves_world_geometry_on_instanced_model() {
        // duplex has rep-identity groups the streaming path deliberately skips
        // (bounded memory cannot hold every occurrence). World geometry must be
        // identical anyway: same element nodes, same total placed triangles.
        let Some(content) = fixture_opt("ara3d/duplex.ifc") else { return };
        let opts = GltfOptions::default();
        let (in_memory, _) = export_glb_from_result(process_geometry(&content), &opts);
        let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
        assert!(stream_stats.meshes > 0);
        let (mem_json, _) = parse_glb(&in_memory);
        let (str_json, str_bin) = parse_glb(&streamed);
        // One element node per visible mesh occurrence on both paths (+1 root each).
        assert_eq!(
            mem_json["nodes"].as_array().unwrap().len(),
            str_json["nodes"].as_array().unwrap().len(),
            "element node count must match",
        );
        assert_eq!(
            world_triangles(&mem_json),
            world_triangles(&str_json),
            "world triangle count must match",
        );
        // The BIN must be exactly the three runs the JSON declares.
        let declared: u64 = str_json["bufferViews"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bv| bv["byteLength"].as_u64().unwrap())
            .sum();
        // pos/norm are 12-byte and idx 4-byte multiples, so the BIN needs no padding
        // and must be exactly the three declared runs.
        assert_eq!(declared as usize, str_bin.len(), "BIN length matches declared runs");
    }

    #[test]
    fn streaming_bounded_quantized_is_byte_identical_on_flat_models() {
        for rel in ["ifcopenshell/1019-column.ifc", "ifcopenshell/1030-sphere.ifc"] {
            let Some(content) = fixture_opt(rel) else { continue };
            let opts = GltfOptions {
                quantize: true,
                include_metadata: true,
                ..GltfOptions::default()
            };
            let (in_memory, mem_stats) = export_glb_from_result(process_geometry(&content), &opts);
            let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
            assert_eq!(mem_stats.meshes, stream_stats.meshes, "{rel}: mesh stats");
            assert_eq!(in_memory, streamed, "{rel}: quantized bounded must be byte-identical");
        }
    }

    #[test]
    fn streaming_bounded_quantized_preserves_world_geometry_on_instanced_model() {
        let Some(content) = fixture_opt("ara3d/duplex.ifc") else { return };
        let opts = GltfOptions { quantize: true, ..GltfOptions::default() };
        let (in_memory, _) = export_glb_from_result(process_geometry(&content), &opts);
        let (streamed, stream_stats) = export_glb_streaming_bounded(&content, &opts);
        assert!(stream_stats.meshes > 0);
        let (mem_json, _) = parse_glb(&in_memory);
        let (str_json, _) = parse_glb(&streamed);
        // Node counts legitimately differ (the in-memory instanced quantized path
        // nests a dequant child under a placement parent), but each occurrence
        // carries exactly one mesh node on both paths, so placed triangles agree.
        assert_eq!(
            world_triangles(&mem_json),
            world_triangles(&str_json),
            "world triangle count must match",
        );
        assert_eq!(
            str_json["extensionsRequired"][0].as_str(),
            Some("KHR_mesh_quantization"),
        );
    }

    #[test]
    fn streaming_bounded_matches_in_memory_on_empty_model() {
        let empty = GEOMETRYLESS_IFC.as_bytes();
        let opts = GltfOptions::default();
        let (in_memory, _) = export_glb_from_result(process_geometry(empty), &opts);
        let (streamed, stats) = export_glb_streaming_bounded(empty, &opts);
        assert_eq!(stats.meshes, 0);
        assert_eq!(in_memory, streamed, "empty-model GLB must be byte-identical");
    }
}
