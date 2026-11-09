// SPDX-License-Identifier: MPL-2.0
//! The `RhinoScene` records and their wire encoding (manifest JSON plus one
//! little-endian blob). Field names are the wire contract in
//! `docs/architecture/rhino-3dm-export.md`; the TypeScript adapter reads them.

use serde::Serialize;

/// Manifest `format` tag.
pub const RHINO_SCENE_FORMAT: &str = "ifc-lite.rhino-scene";
/// Manifest `version`; bumped on any incompatible change.
pub const RHINO_SCENE_VERSION: u32 = 1;

/// Document settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhinoSettings {
    /// rhino3dm `UnitSystem` member name.
    pub unit_system: &'static str,
    pub meters_per_unit: f64,
    /// 1 mm in `unit_system`.
    pub absolute_tolerance: f64,
    pub angle_tolerance_degrees: f64,
    pub earth_anchor: Option<EarthAnchor>,
}

/// Rhino earth anchor point, from `IfcSite.RefLatitude` / `RefLongitude`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarthAnchor {
    pub latitude: f64,
    pub longitude: f64,
    /// Metres.
    pub elevation: f64,
    /// The site placement origin in written coordinates and units.
    pub model_base_point: [f64; 3],
    /// Unit direction of true north in written coordinates.
    pub model_north: [f64; 3],
    /// Unit direction of east in written coordinates.
    pub model_east: [f64; 3],
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RhinoLayer {
    pub name: String,
    pub parent: Option<usize>,
    pub color: [u8; 4],
    pub visible: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RhinoMaterial {
    pub name: String,
    pub diffuse: [u8; 3],
    pub transparency: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RhinoGroup {
    pub name: String,
}

/// One triangle mesh: positions in output units and coordinates.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RhinoMesh {
    /// xyz triplets.
    pub positions: Vec<f64>,
    /// xyz triplets, one per vertex; `None` when normals are off.
    pub normals: Option<Vec<f32>>,
    /// Triangles.
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RhinoBlock {
    pub name: String,
    pub description: String,
    pub meshes: Vec<usize>,
    pub layer: usize,
}

/// What an object draws.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RhinoGeometry {
    Mesh { mesh: usize },
    /// `xform` is row-major and maps block coordinates to written coordinates.
    Instance { block: usize, xform: [f64; 16] },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhinoObject {
    #[serde(flatten)]
    pub geometry: RhinoGeometry,
    pub layer: usize,
    pub name: String,
    /// UUID string; see "Object identity" in the spec.
    pub object_id: String,
    pub color: [u8; 4],
    pub material: usize,
    pub groups: Vec<usize>,
    pub user_strings: Vec<(String, String)>,
}

/// The scene: plain data saying which layer, material, group, block and user
/// strings every object gets. [`RhinoScene::encode`] produces the wire form;
/// it destructures every field, so a field added here does not compile until
/// it has a place in the manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct RhinoScene {
    pub settings: RhinoSettings,
    pub warnings: Vec<String>,
    pub document_strings: Vec<(String, String)>,
    pub layers: Vec<RhinoLayer>,
    pub materials: Vec<RhinoMaterial>,
    pub groups: Vec<RhinoGroup>,
    pub meshes: Vec<RhinoMesh>,
    pub blocks: Vec<RhinoBlock>,
    pub objects: Vec<RhinoObject>,
}

/// A blob section: byte offset and element count.
#[derive(Serialize)]
struct BufferRef {
    offset: usize,
    count: usize,
}

#[derive(Serialize)]
struct WireMesh {
    positions: BufferRef,
    normals: Option<BufferRef>,
    indices: BufferRef,
}

/// The manifest JSON: the scene's fields in declaration order, with `meshes`
/// as blob references.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    format: &'static str,
    version: u32,
    settings: &'a RhinoSettings,
    warnings: &'a [String],
    document_strings: &'a [(String, String)],
    layers: &'a [RhinoLayer],
    materials: &'a [RhinoMaterial],
    groups: &'a [RhinoGroup],
    meshes: &'a [WireMesh],
    blocks: &'a [RhinoBlock],
    objects: &'a [RhinoObject],
}

/// Append `values` little-endian to `blob` as the next section, starting on
/// an 8-byte boundary (zero-padded up to it).
fn push_section<T: Copy, const N: usize>(blob: &mut Vec<u8>, values: &[T], to_le: impl Fn(T) -> [u8; N]) -> BufferRef {
    let offset = blob.len().next_multiple_of(8);
    blob.resize(offset, 0);
    blob.reserve(values.len() * N);
    for &v in values {
        blob.extend_from_slice(&to_le(v));
    }
    BufferRef { offset, count: values.len() }
}

impl RhinoScene {
    /// The manifest JSON and the blob it references.
    ///
    /// Each mesh's sections are `positions` (f64), then `normals` (f32) when
    /// present, then `indices` (u32), back to back, every section 8-byte
    /// aligned and little-endian, so an adapter takes typed-array views
    /// without copying. Consumes the scene and drops each mesh once its bytes
    /// are written; that does not lower the peak (the blob grows while the
    /// later meshes are still alive, and wasm linear memory never shrinks).
    pub fn encode(self) -> (String, Vec<u8>) {
        let RhinoScene { settings, warnings, document_strings, layers, materials, groups, meshes, blocks, objects } = self;
        let mut blob = Vec::new();
        let refs: Vec<WireMesh> = meshes
            .into_iter()
            .map(|m| WireMesh {
                positions: push_section(&mut blob, &m.positions, f64::to_le_bytes),
                normals: m.normals.as_deref().map(|n| push_section(&mut blob, n, f32::to_le_bytes)),
                indices: push_section(&mut blob, &m.indices, u32::to_le_bytes),
            })
            .collect();
        let manifest = Manifest {
            format: RHINO_SCENE_FORMAT,
            version: RHINO_SCENE_VERSION,
            settings: &settings,
            warnings: &warnings,
            document_strings: &document_strings,
            layers: &layers,
            materials: &materials,
            groups: &groups,
            meshes: &refs,
            blocks: &blocks,
            objects: &objects,
        };
        // Plain structs of strings, integers and finite floats: nothing here can fail.
        let json = serde_json::to_string(&manifest).expect("rhino scene manifest serializes");
        (json, blob)
    }
}
