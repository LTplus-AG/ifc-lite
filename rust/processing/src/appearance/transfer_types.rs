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
/// Which side a point-cloud sample faces. Every plan records the source it used
/// so the "no nearest-Gaussian shortcut" rule stays auditable (#4381).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PointOrientation {
    /// Oriented per-point normals supplied by the capture (PLY/E57/PCD normals).
    SourceNormals,
    /// Local plane normals oriented toward each point's scanner station.
    Viewpoints,
    /// Local plane normals oriented toward the IFC face being sampled. The
    /// thin-wall guarantee then rests on the target self-occlusion rule alone.
    TargetReferenced,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSourcePoints {
    /// Number of points in the binary payload (positions 3n f64, colors 3n u8).
    pub point_count: u32,
    pub orientation: PointOrientation,
    /// Local plane support radius around the nearest point. Bounded by 0.5 m.
    pub neighborhood_radius_metres: f64,
    /// Fewer supporting points than this leave the sample unknown (sparse).
    pub min_neighbors: u32,
    /// Nearest points retained for one local fit. At most 256.
    pub max_neighbors: u32,
    /// Largest accepted RMS plane distance of the support; larger is ambiguous
    /// (edge, clutter or two unseparable sheets), never averaged through.
    pub surface_band_metres: f64,
    /// Scanner station positions in the source frame; the payload's per-point
    /// station index selects one. Required for `viewpoints`, otherwise empty.
    pub viewpoints: Vec<[f64; 3]>,
}
/// One registered capture: a textured mesh or an RGB point cloud.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferSource {
    Mesh(TransferSourceMesh),
    Points(TransferSourcePoints),
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
    pub source: TransferSource,
    /// The mesh source's decoded texture inside the RGBA payload; absent for points.
    #[serde(default)]
    pub source_image: Option<AppearanceRaster>,
    /// Existing target IFC images, required wherever source appearance uses them.
    pub source_images: Vec<AppearanceSourceRaster>,
    pub texels_per_metre: f64,
    pub max_distance_metres: f64,
    pub min_normal_dot: f64,
    pub ambiguity_distance_metres: f64,
    /// How far a same-facing observation may lie behind the IFC face before it
    /// is rejected as beyond the surface (thin-wall far side, oversized IFC).
    /// Bounded by `max_distance_metres`; never a registration accuracy estimate.
    pub max_behind_metres: f64,
}
/// Binary point payload accompanying a `TransferSource::Points` request.
/// Positions are source-frame metres; colors are RGB8; `normals` (3n f32,
/// oriented) and `stations` (n indices into `viewpoints`) are empty when absent.
#[derive(Debug, Clone, Copy)]
pub struct TransferPointPayload<'a> {
    pub positions: &'a [f64],
    pub colors: &'a [u8],
    pub normals: &'a [f32],
    pub stations: &'a [u32],
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCoverage {
    pub samples: u64,
    pub observed_samples: u64,
    /// One independent geometric observation per target triangle, including subpixel charts.
    pub centroid_samples: u64,
    pub observed_centroid_samples: u64,
    /// Actual raster pixel centers inside target charts; excludes guard padding and centroids.
    pub raster_interior_texels: u64,
    pub observed_raster_interior_texels: u64,
    pub unknown_distance_samples: u64,
    pub unknown_normal_samples: u64,
    pub unknown_ambiguous_samples: u64,
    /// Same-facing nearest surface deeper than `max_behind_metres` behind the target face,
    /// or a point-cloud support reached only through another face of the target.
    pub unknown_behind_samples: u64,
    /// Point sources only: too few supporting points for a local surface fit.
    pub unknown_sparse_samples: u64,
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
/// Which capture kind and orientation source produced a plan (#4381).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSourceSummary {
    pub kind: String,
    pub orientation: Option<PointOrientation>,
    pub point_count: Option<u32>,
}
/// Work actually charged against the fixed transfer budget, so a plan's cost is
/// auditable next to its coverage (#4381).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferBudgetReport {
    pub work_used: u64,
    pub work_limit: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshTransferSummary {
    /// Binds the entire typed request, supplied RGBA/point bytes and effective IFC bytes.
    pub prepared_sha256: String,
    pub source: TransferSourceSummary,
    pub budget: TransferBudgetReport,
    pub registration_sha256: String,
    /// Full fit/check residuals remain reviewable; mathematical solve is not approval.
    pub registration: super::ScanRegistrationReport,
    pub applicable: bool,
    pub coverage: TransferCoverage,
    pub items: Vec<TransferItemCoverage>,
    /// Target eligibility refusals survive even when no applicable plan exists.
    pub exclusions: Vec<super::Exclusion>,
    pub diagnostics: Vec<String>,
}
#[derive(Debug)]
pub struct MeshTransferPlan {
    /// None without observed interior raster texels or at least 4 fit/4 held-out observations.
    pub output: Option<PageAppearancePlan>,
    pub transfer: MeshTransferSummary,
    pub texels_per_metre: f64,
}
