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

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};
// Only the test module uses std's SipHash-keyed `HashMap` (its own scratch maps); the
// exporter's own dedup/material maps are all `FxHashMap`.
#[cfg(test)]
use std::collections::HashMap;

// The GLB binary layout is little-endian, and several hot paths reinterpret f32/u32
// slices as raw bytes via `bytemuck::cast_slice` (vertex/normal/index encoding and the
// content-dedup hash) — only byte-equivalent to `to_le_bytes` on a LE target. Every
// target this crate ships for (wasm32, x86_64, aarch64) is LE; make a big-endian build
// fail HERE rather than silently emit corrupt GLBs.
const _: () = assert!(
    cfg!(target_endian = "little"),
    "ifc-lite-export assumes a little-endian target (GLB is LE; cast_slice byte reinterpretation)",
);

use crate::error::ExportError;
use ifc_lite_core::EntityIndex;
use ifc_lite_geometry::{collate_refs, InstanceMeshRef, InstanceMeta, InstanceTemplate};
use ifc_lite_processing::{
    process_geometry, process_geometry_streaming_filtered_with_options, process_geometry_with_index,
    build_entity_index_parallel, MeshData, OpeningFilterMode, ProcessingResult, StreamingOptions,
};
use serde::Serialize;
use serde_json::{json, Value};

// Split-out submodules (kept child modules so they can reach this module's private
// assembler internals via `super`; the code moved verbatim, so output is unchanged).
mod from_meshes;
mod matrix;

pub use from_meshes::{export_glb_from_meshes, try_export_glb_from_meshes};
use matrix::{affine_inverse, compose_world_meta, occurrence_node_matrix};

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
    /// Make every material self-illuminating by setting `emissiveFactor` to its
    /// base colour. Targets renderers with no ambient/IBL and a single hard sun —
    /// notably **Google Earth**, which ignores `KHR_materials_unlit` and lit the
    /// model so dark that shadow-side faces went black (#1427). `emissiveFactor`
    /// is core glTF 2.0 (not an extension), so every compliant renderer honours
    /// it; the base colour is kept too, so a viewer that ignores emissive is no
    /// worse than today (never blacker than the lit result). Default `false`.
    pub emissive: bool,
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
            emissive: false,
            model_id: None,
            quantize: false,
        }
    }
}

/// Coverage stats for a GLB export.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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
    // `Some` only for emissive exports (#1427): RGB self-illumination equal to the
    // base colour, so renderers without ambient/IBL (Google Earth) still show the
    // true colour instead of a sun-shaded near-black. Core glTF 2.0, so universal.
    #[serde(rename = "emissiveFactor", skip_serializing_if = "Option::is_none")]
    emissive_factor: Option<[f32; 3]>,
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

/// Precomputed visibility filter. The express-id allow/deny lists and the hidden-type
/// set are hashed ONCE per export instead of linearly scanned per mesh — `mesh_visible`
/// ran `Vec::contains` over `opts.hidden`/`opts.isolated`/`opts.hidden_types` for every
/// mesh, i.e. O(meshes × filter_len), and on the bounded path it ran in BOTH passes.
/// Same decisions as the old scan, so no output changes.
struct VisibilityFilter {
    hidden: FxHashSet<u32>,
    isolated: FxHashSet<u32>,
    isolated_active: bool,
    hidden_types: FxHashSet<String>,
}

impl VisibilityFilter {
    fn new(opts: &GltfOptions) -> Self {
        Self {
            hidden: opts.hidden.iter().copied().collect(),
            isolated: opts.isolated.iter().copied().collect(),
            isolated_active: !opts.isolated.is_empty(),
            hidden_types: opts.hidden_types.iter().cloned().collect(),
        }
    }

    fn visible(&self, mesh: &MeshData) -> bool {
        if mesh.geometry_class == 2 {
            return false; // instanced type library duplicates occurrence geometry
        }
        if self.hidden.contains(&mesh.express_id) {
            return false;
        }
        if self.isolated_active && !self.isolated.contains(&mesh.express_id) {
            return false;
        }
        if self.hidden_types.contains(&mesh.ifc_type) {
            return false;
        }
        // Geometry sanity: matching, non-empty, triangulated.
        !mesh.indices.is_empty()
            && mesh.positions.len() >= 9
            && mesh.positions.len().is_multiple_of(3)
            && mesh.normals.len() == mesh.positions.len()
    }
}

/// Convenience wrapper that builds a one-shot [`VisibilityFilter`] — used by tests that
/// check a single mesh. Production hot loops build the filter once and call
/// [`VisibilityFilter::visible`] directly, so this is test-only.
#[cfg(test)]
fn mesh_visible(mesh: &MeshData, opts: &GltfOptions) -> bool {
    VisibilityFilter::new(opts).visible(mesh)
}

/// Material dedup key: RGBA rounded to 2 decimals (matches the TS exporter's key).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// One material for a mesh colour: the single source of the lit / unlit / emissive
/// rules, shared by every assembler so the paths cannot drift. `emissive` takes
/// precedence over `unlit` because the KHR_materials_unlit spec mandates
/// `emissiveFactor = 0`, making the two mutually exclusive; never emit a
/// spec-violating material that declares unlit AND a non-zero emissiveFactor (#1427).
fn make_material(color: [f32; 4], lit: bool, emissive: bool) -> Material {
    Material {
        pbr: Pbr {
            base_color_factor: color,
            metallic_factor: 0.0,
            roughness_factor: 1.0,
        },
        emissive_factor: emissive.then_some([color[0], color[1], color[2]]),
        extensions: if lit || emissive {
            None
        } else {
            Some(Extensions { khr_materials_unlit: EmptyObj {} })
        },
        alpha_mode: if color[3] < 1.0 { Some("BLEND") } else { None },
        double_sided: true,
    }
}

/// 128-bit content key for the flat-remainder dedup: the mesh's LOCAL geometry
/// (positions / normals / indices, hashed as raw bit patterns) folded with its
/// colour. Two meshes the rep-identity collator did NOT flag instanceable but whose
/// BAKED local buffers are nonetheless bit-identical (same shape, same orientation,
/// same colour) share one emitted glTF mesh placed by a node translation. Colour is
/// in the key because the glTF material rides the primitive, not the node.
///
/// One single-pass `xxh3_128` over the three attribute runs (reinterpreted as bytes,
/// which is a no-op on the LE-only targets this crate builds for — the exact same bit
/// patterns the old per-`f32::to_bits` fold hashed) plus a `u64` length frame before
/// each run so concatenated buffers can't alias. The digest only ever gates key
/// EQUALITY (dedup grouping) and never appears in the output, so bit-identical meshes
/// still collapse together and the emitted GLB is byte-for-byte unchanged; the win is
/// ~20-50x less hashing on large models (xxh3 bulk vs element-wise SipHash-1-3).
///
/// Because the digest never leaves this function, the IMPLEMENTATION is free: any
/// sound 128-bit hash groups the same meshes. That is what makes `twox-hash` (MIT)
/// substitutable for `xxhash-rust` (BSL-1.0) without touching a single output byte.
fn geom_color_key(positions: &[f32], normals: &[f32], indices: &[u32], color: [f32; 4]) -> u128 {
    use twox_hash::XxHash3_128;
    let mut h = XxHash3_128::new();
    h.write(&(positions.len() as u64).to_le_bytes());
    h.write(bytemuck::cast_slice::<f32, u8>(positions));
    h.write(&(normals.len() as u64).to_le_bytes());
    h.write(bytemuck::cast_slice::<f32, u8>(normals));
    h.write(&(indices.len() as u64).to_le_bytes());
    h.write(bytemuck::cast_slice::<u32, u8>(indices));
    let (r, g, b, a) = color_key(color);
    h.write(&r.to_le_bytes());
    h.write(&g.to_le_bytes());
    h.write(&b.to_le_bytes());
    h.write(&a.to_le_bytes());
    h.finish_128()
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
        match self.sink.as_mut() {
            Some(sink) => {
                // Multi-buffer: concatenate this chunk's three runs, hand it to the sink,
                // and reset the runs for the next chunk.
                let mut bin = Vec::with_capacity(total);
                bin.extend_from_slice(&self.pos);
                bin.extend_from_slice(&self.norm);
                bin.extend_from_slice(&self.idx);
                self.pos.clear();
                self.norm.clear();
                self.idx.clear();
                let name = format!("buffer{buf}.bin");
                self.buffers.push(Buffer { byte_length: total as u32, uri: Some(name.clone()) });
                sink(name, bin);
            }
            None => {
                // Single embedded GLB buffer: leave pos/norm/idx in place so the packer
                // writes them straight into the container — no intermediate concatenated
                // copy. `cap == usize::MAX` on this path, so `flush` runs exactly once and
                // the runs are never reset mid-stream. Pin that load-bearing invariant: a
                // second non-empty flush here would push a duplicate buffer AND leave the
                // now-unreset runs to be written twice.
                debug_assert!(
                    self.next_buffer == 0,
                    "single-buffer GLB path must flush exactly once (cap == usize::MAX)",
                );
                self.buffers.push(Buffer { byte_length: total as u32, uri: None });
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
    material_map: &mut FxHashMap<(i32, i32, i32, i32), u32>,
    mesh: &MeshView,
    vertex_offset: [f64; 3],
    lit: bool,
    emissive: bool,
    stats: &mut GltfStats,
) -> u32 {
    let nverts = (mesh.positions.len() / 3) as u32;
    // f32: 24 bytes/vertex (pos+normal) + 4/index. Flush before writing if needed.
    ch.maybe_flush(mesh.positions.len() * 8 + mesh.indices.len() * 4);
    let bv = ch.bv_base();
    let pos_off = ch.pos.len() as u32;
    let norm_off = ch.norm.len() as u32;
    let idx_off = ch.idx.len() as u32;

    // One reservation per run instead of amortized regrowth on every 4-byte push.
    ch.pos.reserve(mesh.positions.len() * 4);
    ch.norm.reserve(mesh.normals.len() * 4);
    ch.idx.reserve(mesh.indices.len() * 4);

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        // Bake each component (f64 add, monotone f32 downcast) into a 12-byte vertex
        // and write it in one extend; the bytes equal three back-to-back
        // `f32::to_le_bytes`, so the buffer is unchanged.
        let mut vbuf = [0u8; 12];
        for k in 0..3 {
            let baked = (p[k] as f64 + vertex_offset[k]) as f32;
            vbuf[k * 4..k * 4 + 4].copy_from_slice(&baked.to_le_bytes());
            if baked < min[k] {
                min[k] = baked;
            }
            if baked > max[k] {
                max[k] = baked;
            }
        }
        ch.pos.extend_from_slice(&vbuf);
    }
    // Normals + indices are copied verbatim (no per-element transform), so reinterpret
    // each whole slice as LE bytes in one memcpy — byte-identical on LE targets (the
    // only ones this crate builds for) to the per-element `to_le_bytes` loop.
    ch.norm.extend_from_slice(bytemuck::cast_slice::<f32, u8>(mesh.normals));
    ch.idx.extend_from_slice(bytemuck::cast_slice::<u32, u8>(mesh.indices));

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
        materials.push(make_material(mesh.color, lit, emissive));
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
    material_map: &mut FxHashMap<(i32, i32, i32, i32), u32>,
    mesh: &MeshView,
    lit: bool,
    emissive: bool,
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
    ch.pos.reserve(nverts as usize * 8);
    let pos_off = ch.pos.len() as u32;
    let mut qmin = [i16::MAX; 3];
    let mut qmax = [i16::MIN; 3];
    for p in mesh.positions.chunks_exact(3) {
        // 3 SHORT + 1 SHORT pad, built in a stack buffer and written once; the trailing
        // two bytes stay zero (== `0i16` LE pad), so the stream is byte-identical.
        let mut vbuf = [0u8; 8];
        for k in 0..3 {
            let n = ((p[k] as f64 - center[k]) / half[k]).clamp(-1.0, 1.0);
            let q = (n * 32767.0).round() as i16;
            vbuf[k * 2..k * 2 + 2].copy_from_slice(&q.to_le_bytes());
            qmin[k] = qmin[k].min(q);
            qmax[k] = qmax[k].max(q);
        }
        ch.pos.extend_from_slice(&vbuf);
    }

    // Normals: SHORT normalized. The mesh node carries the non-uniform dequant scale
    // `half`, so the renderer applies its inverse-transpose `S(1/half)` to each stored
    // normal. Pre-multiply by `half` and renormalize so that cancels and the rendered
    // direction is the true normal. Padded to the same 8-byte stride as positions.
    ch.norm.reserve(nverts as usize * 8);
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
        // 3 SHORT + 1 SHORT pad in a stack buffer; trailing zero pad unchanged.
        let mut vbuf = [0u8; 8];
        for (k, c) in v.into_iter().enumerate() {
            let q = (c.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            vbuf[k * 2..k * 2 + 2].copy_from_slice(&q.to_le_bytes());
        }
        ch.norm.extend_from_slice(&vbuf);
    }

    // Indices: u16 when every index fits (max index = nverts - 1 <= 65535, i.e.
    // nverts <= 65536), else u32. Pad the section to 4 bytes so a following u32-index
    // mesh stays 4-aligned regardless of this mesh's index width.
    let small = nverts <= u16::MAX as u32 + 1;
    let idx_off = ch.idx.len() as u32;
    ch.idx.reserve(mesh.indices.len() * if small { 2 } else { 4 } + 3);
    if small {
        for &i in mesh.indices {
            ch.idx.extend_from_slice(&(i as u16).to_le_bytes());
        }
    } else {
        // u32 indices are copied verbatim — one memcpy of the whole run (LE targets).
        ch.idx.extend_from_slice(bytemuck::cast_slice::<u32, u8>(mesh.indices));
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
        materials.push(make_material(mesh.color, lit, emissive));
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
/// (the `ch.pos`/`ch.norm`/`ch.idx` runs for the single-buffer case, which `pack_glb`
/// writes straight into the container, or already handed to the chunk sink).
// Cohesive builder: these are the orthogonal knobs of one glTF pass (metadata,
// model id, lit/emissive material, RTC origin, quantization) and packing them
// into a struct would not reduce the real coupling. #1427 added `emissive`.
#[allow(clippy::too_many_arguments)]
fn build_gltf(
    views: &[MeshView],
    include_metadata: bool,
    model_id: Option<&str>,
    lit: bool,
    emissive: bool,
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
    let mut material_map: FxHashMap<(i32, i32, i32, i32), u32> = FxHashMap::default();

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
    let mut flat_counts: FxHashMap<u128, u32> = FxHashMap::default();
    for &k in &flat_keys {
        *flat_counts.entry(k).or_insert(0) += 1;
    }
    // Cache key -> (mesh_idx, dequant center, dequant half-extent). The dequant fields
    // are dummy on the f32 path (node scale stays `None`); on the quantized path they
    // are the per-mesh dequant the node folds in.
    let mut flat_cache: FxHashMap<u128, (u32, [f64; 3], [f64; 3])> = FxHashMap::default();
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
                        &mut materials, &mut material_map, mesh, lit, emissive, &mut stats,
                    )
                })
            } else {
                push_mesh_quantized(
                    &mut *ch, &mut accessors, &mut meshes,
                    &mut materials, &mut material_map, mesh, lit, emissive, &mut stats,
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
                    &mut materials, &mut material_map, mesh, [0.0, 0.0, 0.0], lit, emissive, &mut stats,
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
                &mut materials, &mut material_map, mesh, placement, lit, emissive, &mut stats,
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
        let mut by_color: FxHashMap<(i32, i32, i32, i32), Vec<usize>> = FxHashMap::default();
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
                    &mut meshes, &mut materials, &mut material_map, &tmpl_mesh, lit, emissive, &mut stats,
                );
                (mi, Some((center, half)))
            } else {
                let mi = push_mesh(
                    &mut *ch, &mut accessors,
                    &mut meshes, &mut materials, &mut material_map, &tmpl_mesh,
                    [0.0, 0.0, 0.0], lit, emissive, &mut stats,
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
            // Emissive suppresses unlit (mutually exclusive; see make_material).
            if !lit && !emissive && stats.materials > 0 {
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
///
/// Beyond the [`ExportError::NoRenderGeometry`] guard, an input at/above the
/// streaming threshold that would exceed the glTF 4 GiB single-GLB limit returns
/// [`ExportError::TooLarge`] instead of PANICKING (as `export_glb_with_stats`
/// does) — the checked bounded path fails fast after pass 1, so a caller can fall
/// back to [`export_gltf_streaming`] without catching a panic (#1516).
///
/// A SUB-THRESHOLD input (default < 64 MB) keeps the in-memory instanced
/// assembler, which retains the historical 4 GiB `pack_glb` assert. That bound is
/// only reachable if such a small file meshed to over 4 GiB of GLB (a ~64x
/// expansion — not observed in practice); a caller that must be panic-proof even
/// then can force the checked bounded path with
/// `IFC_LITE_GLB_STREAM_THRESHOLD_MB=1`.
pub fn try_export_glb_with_stats(
    content: &[u8],
    opts: &GltfOptions,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    // Mirror `export_glb_with_stats`'s routing, but the large-model branch is the
    // CHECKED bounded assembler (typed TooLarge, no panic). Small models keep the
    // in-memory instanced path (see the doc note on its residual 4 GiB assert).
    let (glb, stats) = if content.len() >= glb_stream_threshold_bytes() {
        try_export_glb_streaming_bounded(content, opts)?
    } else {
        export_glb_from_result(process_geometry(content), opts)
    };
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
    mut result: ProcessingResult,
    opts: &GltfOptions,
    f: impl FnOnce(&[MeshView], [f64; 3]) -> R,
) -> R {
    // `process_geometry` emits the producer-native IFC **Z-up** frame (the Z-up→Y-up
    // swap normally happens at the wasm FFI, which this path never crosses). glTF
    // mandates +Y-up, so convert each visible mesh to Y-up — positions/normals
    // swapped, winding reversed, origin swapped — matching the viewer/legacy output.
    //
    // The visible indices are collected first so the immutable visibility borrow ends
    // before the in-place mutation; then each visible mesh is converted to Y-up IN PLACE
    // (no allocation of a full second copy of the model's geometry — the old `Vec<YUpMesh>`
    // held +1× the whole model resident for the entire assembly). `result` is owned and
    // dropped after `f`, so the mutation is invisible to any other consumer.
    let filter = VisibilityFilter::new(opts);
    let vis_idx: Vec<usize> = result
        .meshes
        .iter()
        .enumerate()
        .filter(|(_, m)| filter.visible(m))
        .map(|(i, _)| i)
        .collect();
    for &i in &vis_idx {
        let m = &mut result.meshes[i];
        crate::frame::to_yup_in_place(&mut m.positions, &mut m.normals, &mut m.indices, &mut m.origin);
    }
    let views: Vec<MeshView> = vis_idx
        .iter()
        .map(|&i| {
            let m = &result.meshes[i];
            MeshView {
                express_id: m.express_id,
                ifc_type: &m.ifc_type,
                global_id: m.global_id.as_deref(),
                positions: &m.positions,
                normals: &m.normals,
                indices: &m.indices,
                color: m.color,
                origin: m.origin,
                // Z-up instancing side-channel; rep-identity grouping is frame- and
                // bake-invariant (the assembler conjugates the transform into Y-up). Left
                // untouched by the in-place swap above, exactly as before.
                instance: m.instance.as_ref(),
            }
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
            views, opts.include_metadata, opts.model_id.as_deref(), opts.lit, opts.emissive,
            rtc_zup, opts.quantize, &mut ch,
        );
        let json = serde_json::to_vec(&gltf).expect("glTF JSON serializes");
        (pack_glb(&json, &ch.pos, &ch.norm, &ch.idx), stats)
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
    sink: impl FnMut(GltfBuffer),
) -> Vec<u8> {
    export_gltf_streaming_impl(content, opts, None, chunk_cap, sink)
}

/// Like [`export_gltf_streaming`] but reuses a pre-built entity index instead of
/// scanning `content` again on EACH of its two passes. A caller that already
/// built the index — e.g. to share with the attribute pass
/// ([`crate::stream_export_model_with_index`]) — passes it here to remove the
/// redundant SIMD scans on the large models this path targets (#1516). `index`
/// MUST come from [`build_entity_index`](crate::build_entity_index) over the same
/// `content`; output is byte-identical to [`export_gltf_streaming`].
pub fn export_gltf_streaming_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
    chunk_cap: usize,
    sink: impl FnMut(GltfBuffer),
) -> Vec<u8> {
    export_gltf_streaming_impl(content, opts, Some(index), chunk_cap, sink)
}

fn export_gltf_streaming_impl(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
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
    // A shared `index` (when present) is injected into BOTH passes' StreamingOptions so
    // neither re-scans `content` for its entity index (#1516).
    let stream_opts = || StreamingOptions {
        retain_emitted_meshes: false,
        entity_index: index.clone(),
        ..StreamingOptions::default()
    };
    let filter = VisibilityFilter::new(opts);
    // One reusable Y-up scratch for BOTH passes (they run sequentially, so the mutable
    // borrow never overlaps) instead of 3 fresh allocations per mesh per pass.
    let mut yscratch = crate::frame::YUpScratch::new();

    let mut wmin = [f64::INFINITY; 3];
    let mut wmax = [f64::NEG_INFINITY; 3];
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !filter.visible(m) {
                    continue;
                }
                crate::frame::to_yup_into(&mut yscratch, &m.positions, &m.normals, &m.indices, m.origin);
                let y = &yscratch;
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
    let mut material_map: FxHashMap<(i32, i32, i32, i32), u32> = FxHashMap::default();
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
                if !filter.visible(m) {
                    continue;
                }
                crate::frame::to_yup_into(&mut yscratch, &m.positions, &m.normals, &m.indices, m.origin);
                let y = &yscratch;
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
                        &mut material_map, &view, opts.lit, opts.emissive, &mut stats,
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
                        &mut material_map, &view, placement, opts.lit, opts.emissive, &mut stats,
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
            // Emissive suppresses unlit (mutually exclusive; see make_material).
            if !opts.lit && !opts.emissive && stats.materials > 0 {
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
    /// Interned per export (Arc<str>): IFC type names come from a tiny fixed set, so the
    /// bounded plan holds one shared allocation per distinct type instead of one String
    /// clone per mesh — the path that exists to bound memory keeps its metadata small.
    ifc_type: Arc<str>,
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

/// GLB container size in bytes: the 12-byte file header + the JSON chunk (8-byte
/// chunk header + 4-aligned payload) + the BIN chunk (8-byte chunk header +
/// 4-aligned payload). Computed in u64 so an oversize model never truncates on
/// wasm32 (32-bit `usize`) — the projected size has to stay a reliable > 4 GiB
/// signal (#1516). Matches the layout `write_bounded_glb`/`pack_glb` emit.
fn glb_container_size(json_len: u64, bin_total: u64) -> u64 {
    let json_pad = (4 - (json_len % 4)) % 4;
    let bin_pad = (4 - (bin_total % 4)) % 4;
    12 + 8 + (json_len + json_pad) + 8 + (bin_total + bin_pad)
}

/// Projected size of the single-GLB export for a model, computed from pass 1
/// only (no output allocation) — issue #1516. A caller uses it to pick single
/// GLB vs multi-buffer glTF ([`export_gltf_streaming`]) WITHOUT the historical
/// "attempt the GLB, catch the 4 GiB panic, re-run as multi-buffer" dance.
#[derive(Debug, Clone, Copy)]
pub struct GlbSizeProjection {
    /// Projected total GLB container size in bytes (padded JSON + padded BIN +
    /// chunk headers). Exact when it fits; a lower bound once oversize (the
    /// truncated buffer numbers in the discarded JSON make it marginally short).
    pub total_bytes: u64,
    /// Projected BIN payload (positions + normals + indices), the value checked
    /// against the glTF 4 GiB per-buffer limit. Always exact (u64, no truncation).
    pub bin_bytes: u64,
    /// `false` when the projected GLB would exceed the glTF 32-bit (4 GiB) limit
    /// — route to [`export_gltf_streaming`] (multi-buffer) instead.
    pub fits_single_glb: bool,
    /// Coverage of the projected export (post content-dedup mesh/vertex/tri counts).
    pub stats: GltfStats,
}

/// Bounded-memory single-**GLB** export: two passes over the deterministic mesh
/// stream (`retain_emitted_meshes: false`, peak input = one batch).
///
/// Pass 1 ([`plan_bounded_glb`]) records per-mesh METADATA only (counts, local
/// bbox, colour, ids, content-hash) plus the world AABB; the complete glTF JSON
/// is then built and the final GLB `Vec` is preallocated at its exact container
/// size. Pass 2 ([`write_bounded_glb`]) re-streams the same meshes and bakes
/// their bytes straight into the output at precomputed offsets. Peak memory = the
/// final artifact + one batch + metadata — never the whole model's `MeshData`,
/// never a growing three-run scratch, and never a second full copy from a final
/// concatenation.
///
/// **Oversize** (projected GLB over the glTF 4 GiB limit) PANICS with the
/// historical messages (a worker classifier matches on them). Prefer
/// [`try_export_glb_streaming_bounded`] to get [`ExportError::TooLarge`] instead,
/// or [`project_glb_size`] to decide up front.
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
    export_glb_streaming_bounded_impl(content, opts, None)
}

/// Like [`export_glb_streaming_bounded`] but reuses a pre-built entity index
/// instead of scanning `content` again on EACH of the two passes — for a caller
/// that already built it (e.g. to share with [`crate::stream_export_model_with_index`]),
/// removing the redundant SIMD scans on the large models this path targets
/// (#1516). `index` MUST come from [`build_entity_index`](crate::build_entity_index)
/// over the same `content`; output is byte-identical.
pub fn export_glb_streaming_bounded_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
) -> (Vec<u8>, GltfStats) {
    export_glb_streaming_bounded_impl(content, opts, Some(index))
}

fn export_glb_streaming_bounded_impl(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
) -> (Vec<u8>, GltfStats) {
    // Build the index ONCE, in parallel on native, so both passes reuse it (no
    // redundant per-pass inline scan). Byte-identical to the shared-index path (#1516).
    let index = index.or_else(|| Some(Arc::new(build_entity_index_parallel(content))));
    let plan = plan_bounded_glb(content, opts, index.clone());
    // Back-compat: an oversize model PANICS with the historical messages (the
    // worker's OutputTooLarge classifier matches on them). `try_export_glb*` /
    // `try_export_glb_streaming_bounded` are the fail-closed alternatives that
    // return `ExportError::TooLarge` instead.
    assert!(
        plan.bin_total <= u32::MAX as u64,
        "GLB binary buffer is {} bytes, over the glTF 32-bit buffer limit \
         (4 GiB); the model is too large for a single GLB",
        plan.bin_total,
    );
    assert!(
        plan.total <= u32::MAX as u64,
        "GLB total size is {} bytes, over the glTF 32-bit container limit (4 GiB)",
        plan.total,
    );
    write_bounded_glb(content, opts, index, plan)
}

/// Fail-closed [`export_glb_streaming_bounded`]: an oversize projected GLB
/// returns [`ExportError::TooLarge`] (carrying the projected byte size) after
/// pass 1 — no output allocation, no panic (#1516). An empty visible set is a
/// valid (zero-mesh) GLB here; use [`try_export_glb_with_stats`] for the
/// [`ExportError::NoRenderGeometry`] guard as well.
pub fn try_export_glb_streaming_bounded(
    content: &[u8],
    opts: &GltfOptions,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    try_export_glb_streaming_bounded_impl(content, opts, None)
}

/// Shared-index [`try_export_glb_streaming_bounded`] (see
/// [`export_glb_streaming_bounded_with_index`]).
pub fn try_export_glb_streaming_bounded_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    try_export_glb_streaming_bounded_impl(content, opts, Some(index))
}

fn try_export_glb_streaming_bounded_impl(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    // Build the index ONCE in parallel and share it across plan + write. This is
    // the fail-closed large-model path, exactly where the parallel scan pays off;
    // with `index=None` it otherwise paid two internal serial scans.
    let index = index.or_else(|| Some(Arc::new(build_entity_index_parallel(content))));
    let plan = plan_bounded_glb(content, opts, index.clone());
    if plan.bin_total > u32::MAX as u64 || plan.total > u32::MAX as u64 {
        return Err(ExportError::TooLarge { bytes: plan.total });
    }
    Ok(write_bounded_glb(content, opts, index, plan))
}

/// Project the single-GLB size for `content` from pass 1 only — the world AABB +
/// per-mesh byte sizes the bounded assembler already computes — WITHOUT meshing
/// twice or allocating the output (#1516). Lets a caller pick single GLB vs
/// multi-buffer glTF up front. Meshes the model once (the price of an exact size).
pub fn project_glb_size(content: &[u8], opts: &GltfOptions) -> GlbSizeProjection {
    project_glb_size_impl(content, opts, None)
}

/// Shared-index [`project_glb_size`] (see [`export_glb_streaming_bounded_with_index`]).
pub fn project_glb_size_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
) -> GlbSizeProjection {
    project_glb_size_impl(content, opts, Some(index))
}

fn project_glb_size_impl(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
) -> GlbSizeProjection {
    let index = index.or_else(|| Some(Arc::new(build_entity_index_parallel(content))));
    let plan = plan_bounded_glb(content, opts, index);
    GlbSizeProjection {
        total_bytes: plan.total,
        bin_bytes: plan.bin_total,
        fits_single_glb: plan.bin_total <= u32::MAX as u64 && plan.total <= u32::MAX as u64,
        stats: plan.stats,
    }
}

/// Everything pass 2 ([`write_bounded_glb`]) needs from pass 1: the finished glTF
/// JSON, the per-mesh write plan (`metas`, each carrying its byte offsets), the
/// three run lengths, and the projected sizes — WITHOUT the vertex bytes (those
/// re-stream on pass 2). Holding this between passes is what lets the caller
/// fail fast on an oversize model before any output is allocated.
struct BoundedGlbPlan {
    metas: Vec<StreamedMeshMeta>,
    json: Vec<u8>,
    /// Positions / normals run lengths; the index run is `bin_total - pos - norm`
    /// (its base offset is `pos_len + norm_len`, so `idx_len` need not be carried).
    pos_len: u64,
    norm_len: u64,
    /// BIN payload size (pos + norm + idx), exact (u64).
    bin_total: u64,
    /// Projected GLB container size (headers + padded JSON + padded BIN). u64 so
    /// an oversize model does not truncate on wasm32 (32-bit `usize`).
    total: u64,
    stats: GltfStats,
}

/// Pass 1 of the bounded assembler: mesh the model once to gather per-mesh
/// metadata + the world AABB, build the complete glTF JSON, and compute the exact
/// output sizes — returning a [`BoundedGlbPlan`] the caller either writes
/// ([`write_bounded_glb`]) or inspects for size ([`project_glb_size`]). Does NOT
/// assert the 4 GiB limits; the caller decides (panic vs typed error).
fn plan_bounded_glb(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
) -> BoundedGlbPlan {
    // A shared `index` (when present) is injected into BOTH passes' StreamingOptions
    // so neither re-scans `content` for its entity index (#1516).
    let stream_opts = || StreamingOptions {
        retain_emitted_meshes: false,
        entity_index: index.clone(),
        ..StreamingOptions::default()
    };

    // ── Pass 1: metadata + world AABB ────────────────────────────────────────
    let filter = VisibilityFilter::new(opts);
    let mut yscratch = crate::frame::YUpScratch::new();
    // Intern IFC type names so each distinct type is heap-allocated once, not per mesh.
    let mut type_intern: FxHashMap<String, Arc<str>> = FxHashMap::default();
    let mut metas: Vec<StreamedMeshMeta> = Vec::new();
    let mut wmin = [f64::INFINITY; 3];
    let mut wmax = [f64::NEG_INFINITY; 3];
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !filter.visible(m) {
                    continue;
                }
                crate::frame::to_yup_into(&mut yscratch, &m.positions, &m.normals, &m.indices, m.origin);
                let y = &yscratch;
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
                // Intern: clone the String key only the first time a type is seen; every
                // later mesh of that type just bumps the shared Arc<str> refcount.
                let ifc_type = match type_intern.get(m.ifc_type.as_str()) {
                    Some(a) => a.clone(),
                    None => {
                        let a: Arc<str> = Arc::from(m.ifc_type.as_str());
                        type_intern.insert(m.ifc_type.clone(), a.clone());
                        a
                    }
                };
                metas.push(StreamedMeshMeta {
                    express_id: m.express_id,
                    ifc_type,
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
    let mut key_counts: FxHashMap<u128, u32> = FxHashMap::default();
    for meta in &metas {
        *key_counts.entry(meta.key).or_insert(0) += 1;
    }
    let mut accessors: Vec<Accessor> = Vec::new();
    let mut meshes: Vec<Mesh> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut materials: Vec<Material> = Vec::new();
    let mut material_map: FxHashMap<(i32, i32, i32, i32), u32> = FxHashMap::default();
    let mut element_node_indices: Vec<u32> = Vec::new();
    let mut stats = GltfStats { meshes: 0, vertices: 0, triangles: 0, materials: 0 };
    // key -> (mesh_idx, dequant center, dequant half). center/half are dummy
    // zeros/ones on the f32 path (node scale stays None), the per-mesh dequant
    // the node folds in on the quantized path (mirrors build_gltf's flat_cache).
    let mut shared_cache: FxHashMap<u128, (u32, [f64; 3], [f64; 3])> = FxHashMap::default();
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
                materials.push(make_material(meta.color, opts.lit, opts.emissive));
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
                meta.ifc_type.as_ref(),
                meta.global_id.as_deref(),
                opts.model_id.as_deref(),
            ),
        });
        element_node_indices.push(node_idx);
    }
    stats.materials = materials.len();

    let bin_total = pos_len + norm_len + idx_len;
    // NOTE: the 4 GiB buffer/container limits are NOT asserted here — the caller
    // decides (panic in `export_glb_streaming_bounded_impl` vs typed
    // `ExportError::TooLarge` in the `try_*`/`project_*` paths). The `bin_total as
    // u32` casts below therefore truncate on an oversize model, but that JSON is
    // only ever emitted when the size fits (an oversize plan is discarded), so
    // every path that actually produces bytes stays correct.
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
            // Emissive suppresses unlit (mutually exclusive; see make_material).
            if !opts.lit && !opts.emissive && stats.materials > 0 {
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

    // Projected container size in u64 (see `glb_container_size`): this crate also
    // compiles to wasm32 (32-bit `usize`), so an oversize model must NOT truncate
    // here — the size has to stay a reliable > 4 GiB fail-fast signal.
    let total = glb_container_size(json.len() as u64, bin_total);

    BoundedGlbPlan { metas, json, pos_len, norm_len, bin_total, total, stats }
}

/// Pass 2 of the bounded assembler: preallocate the exact GLB container from
/// `plan`, write the header + JSON, then re-stream the (deterministic) meshes and
/// bake their bytes straight into the BIN region at the precomputed offsets.
/// Callers MUST have already validated `plan.total`/`plan.bin_total` fit the glTF
/// 4 GiB limits (panic or typed error) — this assumes they do.
fn write_bounded_glb(
    content: &[u8],
    opts: &GltfOptions,
    index: Option<Arc<EntityIndex>>,
    plan: BoundedGlbPlan,
) -> (Vec<u8>, GltfStats) {
    // Re-stream with the same (optionally shared) index so pass 2 never re-scans
    // for its entity index either (#1516).
    let stream_opts = || StreamingOptions {
        retain_emitted_meshes: false,
        entity_index: index.clone(),
        ..StreamingOptions::default()
    };
    let BoundedGlbPlan { metas, json, pos_len, norm_len, bin_total, total, stats } = plan;

    // ── Preallocate the exact GLB container, then pass 2 writes into it ─────
    // Safe to narrow to usize here: the caller validated `total`/`bin_total` fit
    // the 4 GiB glTF limit, so every value below is < u32::MAX on any target.
    let total = total as usize;
    let json_pad = (4 - (json.len() % 4)) % 4;
    let bin_pad = ((4 - (bin_total % 4)) % 4) as usize;
    let padded_json = json.len() + json_pad;
    let padded_bin = bin_total as usize + bin_pad;
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

    let filter = VisibilityFilter::new(opts);
    let mut yscratch = crate::frame::YUpScratch::new();
    let mut cursor = 0usize;
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        stream_opts(),
        |batch, _, _| {
            for m in batch {
                if !filter.visible(m) {
                    continue;
                }
                crate::frame::to_yup_into(&mut yscratch, &m.positions, &m.normals, &m.indices, m.origin);
                let y = &yscratch;
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


/// Pack a glTF JSON document and the binary buffer's three runs (positions | normals |
/// indices) into a GLB container (little-endian). The runs are appended straight into the
/// output — no intermediate concatenated `bin` copy — so the single-buffer GLB path holds
/// only one full copy of the geometry at pack time instead of two.
fn pack_glb(json_bytes: &[u8], pos: &[u8], norm: &[u8], idx: &[u8]) -> Vec<u8> {
    let bin_len = pos.len() + norm.len() + idx.len();
    let json_pad = (4 - (json_bytes.len() % 4)) % 4;
    let bin_pad = (4 - (bin_len % 4)) % 4;
    let padded_json = json_bytes.len() + json_pad;
    let padded_bin = bin_len + bin_pad;

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

    // BIN chunk (zero-padded): the three runs written back-to-back are byte-identical to
    // the old `positions ++ normals ++ indices` concatenation.
    out.extend_from_slice(&(padded_bin as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(pos);
    out.extend_from_slice(norm);
    out.extend_from_slice(idx);
    out.extend(std::iter::repeat_n(0x00, bin_pad));

    out
}

#[cfg(test)]
#[path = "gltf_tests.rs"]
mod tests;
