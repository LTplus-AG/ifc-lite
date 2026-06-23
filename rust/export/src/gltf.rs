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

use ifc_lite_processing::{process_geometry, MeshData};
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
}

impl Default for GltfOptions {
    fn default() -> Self {
        Self {
            include_metadata: false,
            isolated: Vec::new(),
            hidden: Vec::new(),
            hidden_types: Vec::new(),
            lit: true,
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
        && mesh.positions.len() % 3 == 0
        && mesh.normals.len() == mesh.positions.len()
}

/// Material dedup key: RGBA rounded to 2 decimals (matches the TS exporter's key).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
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
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub indices: &'a [u32],
    pub color: [f32; 4],
    pub origin: [f64; 3],
}

fn view_ok(v: &MeshView) -> bool {
    !v.indices.is_empty()
        && v.positions.len() >= 9
        && v.positions.len() % 3 == 0
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
fn assemble_glb(views: &[MeshView], include_metadata: bool, lit: bool) -> (Vec<u8>, GltfStats) {
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

    // ── Pass 2: bake centre-relative positions + assemble accessors/nodes ───
    for mesh in &visible {
        let nverts = (mesh.positions.len() / 3) as u32;
        let o = mesh.origin;

        let pos_off = positions.len() as u32;
        let norm_off = normals.len() as u32;
        let idx_off = indices.len() as u32;

        // Bake each vertex into the scene-centre-relative frame (f32). Bounds are
        // taken on the baked coords — accessor space is exactly the buffer bytes.
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for p in mesh.positions.chunks_exact(3) {
            for k in 0..3 {
                let baked = ((p[k] as f64 + o[k]) - scene_center[k]) as f32;
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

        // Material (dedup by rounded RGBA).
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

        let extras = if include_metadata {
            Some(json!({ "expressId": mesh.express_id, "ifcType": mesh.ifc_type }))
        } else {
            None
        };
        let node_idx = nodes.len() as u32;
        nodes.push(Node { mesh: Some(mesh_idx), children: None, translation: None, extras });
        element_node_indices.push(node_idx);

        stats.meshes += 1;
        stats.vertices += nverts as usize;
        stats.triangles += mesh.indices.len() / 3;
    }
    stats.materials = materials.len();

    // Single root node carries the model-wide centre (omitted when ~zero) and
    // parents every element node, so the scene has exactly one top-level node.
    let center_nonzero =
        scene_center.iter().any(|c| c.abs() > f64::EPSILON);
    let scene_nodes = if element_node_indices.is_empty() {
        Vec::new()
    } else {
        let root_idx = nodes.len() as u32;
        nodes.push(Node {
            mesh: None,
            children: Some(element_node_indices),
            translation: if center_nonzero { Some(scene_center) } else { None },
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

    let mut bin = Vec::with_capacity((pos_len + norm_len + idx_len) as usize);
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
    let result = process_geometry(content);
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
            positions: &y.positions,
            normals: &y.normals,
            indices: &y.indices,
            color: m.color,
            origin: y.origin,
        })
        .collect();
    assemble_glb(&views, opts.include_metadata, opts.lit)
}

/// Assemble a GLB from already-produced meshes (the viewer's MeshData — **no re-meshing**).
/// Per mesh `i`: `vertex_counts[i]` vertices + `index_counts[i]` indices, taken in order
/// from the concatenated `positions`/`normals`/`indices`; `colors` is RGBA per mesh,
/// `origins` is xyz per mesh, `express_ids` labels each mesh. Indices are per-mesh LOCAL.
/// Callers pass exactly the meshes they want emitted (visibility filtering is theirs).
#[allow(clippy::too_many_arguments)]
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
            positions: pslice,
            normals: nslice,
            indices: islice,
            color,
            origin,
        });
        vbase += vc;
        ibase += ic;
    }
    assemble_glb(&views, include_metadata, lit)
}

/// Pack a glTF JSON document and binary buffer into a GLB container (little-endian).
fn pack_glb(json_bytes: &[u8], bin: &[u8]) -> Vec<u8> {
    let json_pad = (4 - (json_bytes.len() % 4)) % 4;
    let bin_pad = (4 - (bin.len() % 4)) % 4;
    let padded_json = json_bytes.len() + json_pad;
    let padded_bin = bin.len() + bin_pad;

    let total = 12 + 8 + padded_json + 8 + padded_bin;
    let mut out = Vec::with_capacity(total);

    // GLB header
    out.extend_from_slice(b"glTF"); // magic 0x46546C67 little-endian
    out.extend_from_slice(&2u32.to_le_bytes()); // version
    out.extend_from_slice(&(total as u32).to_le_bytes());

    // JSON chunk (space-padded)
    out.extend_from_slice(&(padded_json as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(json_bytes);
    out.extend(std::iter::repeat(0x20).take(json_pad));

    // BIN chunk (zero-padded)
    out.extend_from_slice(&(padded_bin as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(bin);
    out.extend(std::iter::repeat(0x00).take(bin_pad));

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
        // One mesh-node per element + a single root node that parents them all.
        assert_eq!(nodes.len(), stats.meshes + 1);
        assert_eq!(meshes.len(), stats.meshes);

        // Scene has exactly one top-level node: the root. It carries the placement
        // translation and lists every element node as a child; element nodes
        // themselves carry NO translation (placement is baked relative to centre).
        let scene_nodes = json["scenes"][0]["nodes"].as_array().unwrap();
        assert_eq!(scene_nodes.len(), 1, "single root node");
        let root_idx = scene_nodes[0].as_u64().unwrap() as usize;
        let root = &nodes[root_idx];
        assert!(root.get("mesh").is_none(), "root is a transform node, no mesh");
        assert_eq!(
            root["children"].as_array().unwrap().len(),
            stats.meshes,
            "root parents every element node"
        );
        for (i, n) in nodes.iter().enumerate() {
            if i != root_idx {
                assert!(n.get("translation").is_none(), "element nodes carry no translation");
                assert!(n["mesh"].is_number(), "element nodes reference a mesh");
            }
        }

        // Materials present + LIT by default (#1321: no KHR_materials_unlit) +
        // double-sided.
        assert!(json["materials"].as_array().unwrap().len() >= 1);
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
        let normals: Vec<f32> = std::iter::repeat([0.0f32, 0.0, 1.0]).take(8).flatten().collect();
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
    fn unlit_option_emits_khr_materials_unlit() {
        // #1321: lit = false reproduces the historical flat material — every
        // material tagged KHR_materials_unlit and the extension declared globally.
        let positions: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let normals: Vec<f32> = std::iter::repeat([0.0f32, 0.0, 1.0]).take(4).flatten().collect();
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
