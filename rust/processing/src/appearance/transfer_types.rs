// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{
    AppearanceRaster, AppearanceSourceRaster, PageAppearancePlan, ScanRegistrationRequest,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferFrame {
    /// Row-major proper rotation. Maps native IFC world into registered target frame.
    pub rotation: [[f64; 3]; 3],
    pub source_anchor: [f64; 3],
    pub target_anchor: [f64; 3],
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSourceMesh {
    /// Original canonical GLB primitive ordinal, retained by the host.
    pub mesh_ordinal: u32,
    /// GLB native scene Y-up metres, node transforms and mesh origin included;
    /// excludes model placement, federation offsets and viewer rebasing.
    pub positions: Vec<[f64; 3]>,
    /// Zero-based triangle indices. Source winding must describe the observed face.
    pub triangles: Vec<[u32; 3]>,
    /// Per-vertex GLB top-down UVs after KHR_texture_transform. Duplicated vertices retain seams.
    pub uvs: Vec<[f64; 2]>,
    pub base_color_factor: [f32; 4],
    pub repeat_s: bool,
    pub repeat_t: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeshTransferRequest {
    pub schema: String,
    pub source_revision: String,
    pub next_express_id: u32,
    pub product_ids: Vec<u32>,
    /// Frozen correspondence inputs. Only fitting points determine the transform.
    pub registration: ScanRegistrationRequest,
    pub registration_sha256: String,
    /// Required even for identity: the host derives this from actual placement state.
    pub target_from_ifc_world: TransferFrame,
    pub source_mesh: TransferSourceMesh,
    pub source_image: AppearanceRaster,
    /// Existing target IFC images, required wherever source appearance uses them.
    pub source_images: Vec<AppearanceSourceRaster>,
    pub texels_per_metre: f64,
    pub max_distance_metres: f64,
    pub min_normal_dot: f64,
    pub ambiguity_distance_metres: f64,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCoverage {
    pub samples: u64,
    pub observed_samples: u64,
    pub unknown_distance_samples: u64,
    pub unknown_normal_samples: u64,
    pub unknown_ambiguous_samples: u64,
    /// Triangle-area-weighted fraction of centroid/interior-texel samples, not an exact area integral.
    pub observed_area_estimate_m2: f64,
    pub unknown_area_estimate_m2: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItemCoverage {
    pub product_id: u32,
    pub geometry_item_id: u32,
    #[serde(flatten)]
    pub coverage: TransferCoverage,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshTransferSummary {
    /// Binds the entire typed request, supplied RGBA bytes and effective IFC bytes.
    pub prepared_sha256: String,
    pub registration_sha256: String,
    /// Full fit/check residuals remain reviewable; mathematical solve is not approval.
    pub registration: super::ScanRegistrationReport,
    pub applicable: bool,
    pub coverage: TransferCoverage,
    pub items: Vec<TransferItemCoverage>,
    pub diagnostics: Vec<String>,
}
#[derive(Debug)]
pub struct MeshTransferPlan {
    /// None for wholly unknown coverage or fewer than 4 fit/4 held-out observations.
    pub output: Option<PageAppearancePlan>,
    pub transfer: MeshTransferSummary,
    pub texels_per_metre: f64,
}
