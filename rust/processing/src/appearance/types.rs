// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepresentationPolicy {
    #[default]
    Preserve,
    EvaluatedOccurrence,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceRequest {
    /// Parametric conversion is never implicit.
    #[serde(default)]
    pub representation_policy: RepresentationPolicy,
    pub schema: String,
    pub source_revision: String,
    pub next_express_id: u32,
    pub product_ids: Vec<u32>,
    pub image_uri: String,
    pub repeat_s: bool,
    pub repeat_t: bool,
    pub mapping: Mapping,
    /// Reviewable surface targeting for evaluated occurrence conversions only.
    /// A mask binds to the `surface_fingerprint` a previous plan reported.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub face_masks: Vec<FaceMask>,
}
/// Ascending or unordered source triangle ordinals of one product's evaluated
/// surface. A stale fingerprint is an explicit exclusion, never a silent reuse.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FaceMask {
    pub product_id: u32,
    pub surface_fingerprint: String,
    pub triangles: Vec<u32>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mapping {
    #[serde(rename_all = "camelCase")]
    ExistingUv {
        scale: [f64; 2],
        offset: [f64; 2],
        rotation_radians: f64,
    },
    #[serde(rename_all = "camelCase")]
    Planar {
        frame: MappingFrame,
        origin: [f64; 3],
        axis_u: [f64; 3],
        axis_v: [f64; 3],
        metres_per_tile: [f64; 2],
    },
    #[serde(rename_all = "camelCase")]
    Box {
        frame: MappingFrame,
        origin: [f64; 3],
        metres_per_tile: [f64; 3],
    },
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingFrame {
    Item,
    World,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntity {
    pub express_id: u32,
    pub r#type: String,
    /// StoreEditor wire values: '#N' references, '.ENUM.' tokens, JSON lists/numbers/null.
    pub attributes: Vec<Value>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionalEdit {
    pub express_id: u32,
    pub index: usize,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceItem {
    pub product_id: u32,
    pub geometry_item_id: u32,
    /// Source IFC bottom-left texture coordinates, before mesher seam expansion.
    pub tex_coords: Vec<[f64; 2]>,
    /// 1-based, parallel to source CoordIndex (before winding correction).
    pub tex_coord_index: Vec<[u32; 3]>,
    /// Actual final source topology after canonical placement and welding.
    pub source_indices: Vec<u32>,
    /// Final canonical target topology; becomes provenance after Apply.
    pub target_indices: Vec<u32>,
    /// Canonical target vertex pool size; removed degenerate triangles can leave
    /// unused vertices, so the maximum index is not bounded by corner count.
    pub target_vertex_count: usize,
    /// UV pairs in triangle-corner order, with GPU V flip. Fragment consumers
    /// remap canonical corner slots and expand seams without moving geometry.
    pub preview_corner_uvs: Vec<f32>,
    /// Final canonical shading normals in triangle-corner order, converted from
    /// IFC Z-up to renderer Y-up as [nx, nz, -ny], matching MeshDataJs.
    /// UV-dependent welding may choose a different normal representative.
    pub target_corner_normals: Vec<f32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    pub product_id: u32,
    pub reason: String,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePlan {
    /// Explicit occurrence-local conversions, with original renderer provenance.
    pub conversions: Vec<AppearanceConversion>,
    pub source_revision: String,
    pub next_express_id: u32,
    pub next_available_express_id: u32,
    pub created: Vec<CreatedEntity>,
    pub edits: Vec<PositionalEdit>,
    pub removed: Vec<u32>,
    pub items: Vec<AppearanceItem>,
    pub exclusions: Vec<Exclusion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceConversion {
    pub product_id: u32,
    pub representation_id: u32,
    pub source_geometry_item_id: u32,
    pub geometry_item_id: u32,
    pub source_indices: Vec<u32>,
    /// Canonical evaluated IFC Z-up geometry, before any appearance replacement.
    /// Coordinates are local f32 values plus source_origin and rtc_offset in metres.
    pub source_positions: Vec<f32>,
    pub source_normals: Vec<f32>,
    pub source_origin: [f64; 3],
    pub source_color: [f32; 4],
    pub rtc_offset: [f64; 3],
    /// Hex SHA-256 of the product GlobalId, its quantised local evaluated
    /// surface and topology. Face masks bind to this value; express ids are
    /// excluded so a renumbered export keeps its selection. The surface is
    /// evaluated in f32 world space at its current placement, so a placement
    /// edit generally changes the value and reports a mask stale.
    pub surface_fingerprint: String,
    /// Accepted ascending source triangle ordinals that received the
    /// appearance. Absent when the whole surface was converted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_triangles: Option<Vec<u32>>,
    /// The unmasked IfcTriangulatedFaceSet under the same Body wrapper. It keeps
    /// the source surface style and the complementary source triangles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_geometry_item_id: Option<u32>,
    /// Canonical opening meshes removed when their Body becomes Reference.
    /// Inner fields use the shared MeshData wire contract; origin + rtc_offset
    /// restores IFC Z-up metres. These owners are companion dependency roots.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_removed_meshes: Vec<crate::types::mesh::MeshData>,
}
