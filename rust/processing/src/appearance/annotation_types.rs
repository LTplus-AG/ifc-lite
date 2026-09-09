// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::AppearancePlan;
use crate::types::mesh::MeshData;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPlaneFrame {
    /// Bottom-left image corner, IFC world Z-up metres.
    pub origin: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub size_metres: [f64; 2],
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPlaneRequest {
    pub schema: String,
    pub source_revision: String,
    pub next_express_id: u32,
    pub container_id: u32,
    #[serde(rename = "GlobalId")]
    pub global_id: String,
    pub containment_global_id: String,
    #[serde(rename = "Name")]
    pub name: String,
    pub image_uri: String,
    pub frame: AnnotationPlaneFrame,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationPlanePlan {
    pub plan: AppearancePlan,
    pub annotation_id: u32,
    pub geometry_item_id: u32,
    /// Ordinary canonical native MeshData, retaining its existing snake-case
    /// metadata fields and Z-up positions/normals. Host performs FFI conversion.
    pub mesh: MeshData,
    pub coordinate_space: &'static str,
    pub rtc_offset: [f64; 3],
    pub frame: AnnotationPlaneFrame,
}
