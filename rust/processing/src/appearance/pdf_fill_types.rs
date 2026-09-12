// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{AnnotationPlaneFrame, AppearancePlan};
use crate::{
    pdf_vector::{FidelityReport, PdfVectorPage},
    types::mesh::MeshData,
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfFillAnnotationRequest {
    pub schema: String,
    pub source_revision: String,
    pub next_express_id: u32,
    pub container_id: u32,
    #[serde(rename = "GlobalId")]
    pub global_id: String,
    pub containment_global_id: String,
    /// GlobalIds for the provenance `IfcPropertySet` and its
    /// `IfcRelDefinesByProperties`; host-owned like the two above.
    pub property_set_global_id: String,
    pub property_relation_global_id: String,
    #[serde(rename = "Name")]
    pub name: String,
    /// Origin and orthonormal plane axes in native IFC world metres. Size is
    /// the calibrated page extent, not an additional scaling of page geometry.
    pub frame: AnnotationPlaneFrame,
    pub page: PdfVectorPage,
    /// Explicit user acceptance of a partial conversion: the `sha256` of the
    /// fidelity report the host displayed. Required whenever the page is not
    /// exact; when present it must match the report this planner recomputes.
    #[serde(default)]
    pub accepted_fidelity_sha256: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFillRegion {
    pub geometry_item_id: u32,
    pub source_operator_ordinal: u32,
    pub rgb: [f64; 3],
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFillAnnotationPlan {
    pub plan: AppearancePlan,
    pub annotation_id: u32,
    /// Provenance `IfcPropertySet` (`IfcLite_PdfVectorConversion`) row.
    pub property_set_id: u32,
    pub meshes: Vec<MeshData>,
    pub coordinate_space: &'static str,
    pub rtc_offset: [f64; 3],
    pub frame: AnnotationPlaneFrame,
    pub source_ifc_sha256: String,
    pub source_pdf_sha256: String,
    pub page_number: u32,
    /// Complete typed request + effective IFC identity. Host must authenticate
    /// decoded operations against original retained PDF; native receives no PDF.
    pub request_sha256: String,
    pub algorithm: &'static str,
    pub calibration_key: String,
    pub tolerance_metres: f64,
    pub grid_size_metres: f64,
    pub geometry_work: u64,
    pub regions: Vec<PdfFillRegion>,
    /// The verdict this plan was built under; recorded in the provenance set.
    pub fidelity: FidelityReport,
}
