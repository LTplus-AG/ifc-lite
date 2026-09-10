// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use serde::{Deserialize,Serialize};
use super::AppearancePlan;
use crate::types::mesh::MeshData;

/// Explicit segmented surface, not a point cloud or an inferred BIM class.
#[derive(Debug,Clone,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CapturedMesh {
    /// IFC world Z-up metres, independently indexed from UV vertices.
    pub positions:Vec<[f64;3]>,
    /// Zero-based triangle indices; winding is retained.
    pub triangles:Vec<[u32;3]>,
    /// IFC UV convention: V increases upwards. Image bytes remain external.
    pub uvs:Vec<[f64;2]>,
    pub uv_triangles:Vec<[u32;3]>,
}
#[derive(Debug,Clone,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CapturedMeshRequest {
    pub schema:String,
    pub source_revision:String,
    pub next_express_id:u32,
    pub container_id:u32,
    #[serde(rename="GlobalId")]
    pub global_id:String,
    pub containment_global_id:String,
    #[serde(rename="Name")]
    pub name:String,
    pub image_uri:String,
    /// Original image sampler. Omitted fields retain the non-repeating default.
    #[serde(default)]
    pub repeat_s:bool,
    #[serde(default)]
    pub repeat_t:bool,
    pub mesh:CapturedMesh,
}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct CapturedMeshPlan {
    pub plan:AppearancePlan,
    pub object_id:u32,
    pub geometry_item_id:u32,
    pub mesh:MeshData,
    pub coordinate_space:&'static str,
    pub rtc_offset:[f64;3],
}
