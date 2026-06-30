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

use ifc_lite_core::EntityIndex;
use ifc_lite_geometry::{collate_refs, InstanceMeshRef, InstanceMeta, InstanceTemplate};
use ifc_lite_processing::{process_geometry, process_geometry_with_index, MeshData, ProcessingResult};
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

/// Emit one mesh's geometry (positions/normals/indices baked by `vertex_offset`),
/// its three accessors, deduped material, and a glTF `Mesh`; returns the mesh
/// index. `vertex_offset` is added to each local position before the f32 downcast:
/// for a UNIQUE mesh it is `origin - scene_center` (the self-contained
/// world-minus-center bake), for a SHARED mesh it is zero (pure local geometry,
/// placed via the occurrence node's translation). Bumps the deduped `stats`.
#[allow(clippy::too_many_arguments)]
fn push_mesh(
    positions: &mut Vec<u8>,
    normals: &mut Vec<u8>,
    indices: &mut Vec<u8>,
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
    let pos_off = positions.len() as u32;
    let norm_off = normals.len() as u32;
    let idx_off = indices.len() as u32;

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            let baked = (p[k] as f64 + vertex_offset[k]) as f32;
            positions.extend_from_slice(&baked.to_le_bytes());
            if baked < min[k] {
                min[k] = baked;
            }
            if baked > max[k] {
                max[k] = baked;
            }
        }
    }
    for &n in mesh.normals {
        normals.extend_from_slice(&n.to_le_bytes());
    }
    for &i in mesh.indices {
        indices.extend_from_slice(&i.to_le_bytes());
    }

    let pos_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: 0,
        byte_offset: pos_off,
        component_type: 5126, // FLOAT
        count: nverts,
        ty: "VEC3",
        min: Some(min),
        max: Some(max),
    });
    let norm_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: 1,
        byte_offset: norm_off,
        component_type: 5126,
        count: nverts,
        ty: "VEC3",
        min: None,
        max: None,
    });
    let idx_acc = accessors.len() as u32;
    accessors.push(Accessor {
        buffer_view: 2,
        byte_offset: idx_off,
        component_type: 5125, // UNSIGNED_INT
        count: mesh.indices.len() as u32,
        ty: "SCALAR",
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
fn assemble_glb(
    views: &[MeshView],
    include_metadata: bool,
    model_id: Option<&str>,
    lit: bool,
    rtc_zup: [f64; 3],
) -> (Vec<u8>, GltfStats) {
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
    let mut positions: Vec<u8> = Vec::new();
    let mut normals: Vec<u8> = Vec::new();
    let mut indices: Vec<u8> = Vec::new();

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
    let mut flat_cache: HashMap<u128, u32> = HashMap::new();
    for (j, &idx) in flat.iter().enumerate() {
        let mesh = visible[idx];
        let placement = [
            mesh.origin[0] - scene_center[0],
            mesh.origin[1] - scene_center[1],
            mesh.origin[2] - scene_center[2],
        ];
        let key = flat_keys[j];
        let (mesh_idx, translation) = if flat_counts.get(&key).copied().unwrap_or(1) >= 2 {
            // Repeated baked geometry: emit LOCAL once, place via node translation.
            let mi = *flat_cache.entry(key).or_insert_with(|| {
                push_mesh(
                    &mut positions, &mut normals, &mut indices, &mut accessors, &mut meshes,
                    &mut materials, &mut material_map, mesh, [0.0, 0.0, 0.0], lit, &mut stats,
                )
            });
            let tx = placement.iter().any(|c| c.abs() > 1e-9).then_some(placement);
            (mi, tx)
        } else {
            // Singleton: bake world-minus-center into the vertices, identity node.
            let mi = push_mesh(
                &mut positions, &mut normals, &mut indices, &mut accessors, &mut meshes,
                &mut materials, &mut material_map, mesh, placement, lit, &mut stats,
            );
            (mi, None)
        };
        let node_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: Some(mesh_idx),
            children: None,
            translation,
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
            let mesh_idx = push_mesh(
                &mut positions, &mut normals, &mut indices, &mut accessors,
                &mut meshes, &mut materials, &mut material_map, &tmpl_mesh,
                [0.0, 0.0, 0.0], lit, &mut stats,
            );
            for &oi in bucket {
                let occ = &template.occurrences[oi];
                let occ_view = visible[occ.mesh_index];
                // Safe: the partition only kept this group when every occurrence has
                // an instance side-channel and the template inverse exists.
                let occ_meta = occ_view.instance.expect("instanced occurrence has InstanceMeta");
                let matrix = occurrence_node_matrix(
                    occ_meta, &m_ref_inv, rtc_zup, t_origin_yup, scene_center,
                );
                let node_idx = nodes.len() as u32;
                nodes.push(Node {
                    mesh: Some(mesh_idx),
                    children: None,
                    translation: None,
                    matrix: Some(matrix),
                    extras: node_extras(include_metadata, occ_view.express_id, occ_view.ifc_type, occ_view.global_id, model_id),
                });
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
            matrix: None,
            extras: None,
        });
        vec![root_idx]
    };

    // Buffer views over the single concatenated binary buffer.
    let pos_len = positions.len() as u32;
    let norm_len = normals.len() as u32;
    let idx_len = indices.len() as u32;
    let mut buffer_views = Vec::new();
    if pos_len > 0 {
        buffer_views.push(BufferView {
            buffer: 0,
            byte_offset: 0,
            byte_length: pos_len,
            byte_stride: Some(12),
            target: 34962, // ARRAY_BUFFER
        });
        buffer_views.push(BufferView {
            buffer: 0,
            byte_offset: pos_len,
            byte_length: norm_len,
            byte_stride: Some(12),
            target: 34962,
        });
        buffer_views.push(BufferView {
            buffer: 0,
            byte_offset: pos_len + norm_len,
            byte_length: idx_len,
            byte_stride: None,
            target: 34963, // ELEMENT_ARRAY_BUFFER
        });
    }

    // glTF/GLB is a 32-bit container: every buffer offset, byteLength and chunk
    // length is a u32. Past 4 GiB those `as u32` casts silently wrap (release sets
    // overflow-checks = false) and emit a structurally corrupt GLB instead of
    // erroring. Guard the concatenated binary buffer here — every buffer.byteLength
    // and per-mesh accessor/bufferView offset is bounded by it (positions grows
    // monotonically, so an over-limit run aborts before the GLB is packed). The
    // container total (JSON chunk + framing on top) is guarded separately in
    // pack_glb. Summed in usize, which is 64-bit on the native consumers this
    // guard actually protects; on wasm32 usize is 32-bit, but the linear-memory
    // heap OOMs long before 4 GiB so the guard is effectively native-only there.
    let bin_len = positions.len() + normals.len() + indices.len();
    assert!(
        bin_len <= u32::MAX as usize,
        "GLB binary buffer is {bin_len} bytes, over the glTF 32-bit buffer limit \
         (4 GiB); the model is too large for a single GLB",
    );
    let mut bin = Vec::with_capacity(bin_len);
    bin.extend_from_slice(&positions);
    bin.extend_from_slice(&normals);
    bin.extend_from_slice(&indices);

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
        buffer_views,
        buffers: vec![Buffer { byte_length: bin.len() as u32 }],
        extensions_used: if !lit && stats.materials > 0 {
            Some(vec!["KHR_materials_unlit"])
        } else {
            None
        },
    };

    let json_bytes = serde_json::to_vec(&gltf).expect("glTF JSON serializes");
    (pack_glb(&json_bytes, &bin), stats)
}

/// Like [`export_glb`] but also returns coverage stats. Meshes the model from bytes.
pub fn export_glb_with_stats(content: &[u8], opts: &GltfOptions) -> (Vec<u8>, GltfStats) {
    export_glb_from_result(process_geometry(content), opts)
}

/// Like [`export_glb_with_stats`] but reuses a pre-built entity index — for a caller
/// that also runs the attribute pass ([`crate::stream_export_model_with_index`]) over
/// the same bytes, `build_entity_index` once and share it across both. `index` MUST be
/// built from the same `content`; output is byte-identical to `export_glb_with_stats`.
pub fn export_glb_with_stats_with_index(
    content: &[u8],
    opts: &GltfOptions,
    index: Arc<EntityIndex>,
) -> (Vec<u8>, GltfStats) {
    export_glb_from_result(process_geometry_with_index(content, index), opts)
}

fn export_glb_from_result(result: ProcessingResult, opts: &GltfOptions) -> (Vec<u8>, GltfStats) {
    // `process_geometry` emits the producer-native IFC **Z-up** frame (the Z-up→Y-up
    // swap normally happens at the wasm FFI, which this path never crosses). glTF
    // mandates +Y-up, so convert each visible mesh to Y-up — positions/normals
    // swapped, winding reversed, origin swapped — matching the viewer/legacy output.
    // The from-meshes path (`export_glb_from_meshes`) skips this: its `MeshData` is
    // already Y-up.
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
    assemble_glb(&views, opts.include_metadata, opts.model_id.as_deref(), opts.lit, rtc_zup)
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
    // side-channel), so there is no RTC frame to compensate.
    assemble_glb(&views, include_metadata, None, lit, [0.0, 0.0, 0.0])
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
}
