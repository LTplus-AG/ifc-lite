// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Measured output of scan segmentation. Coordinates are in the positions'
//! frame plus `options.origin`, in metres.
use serde::Serialize;

/// Classification hint relative to `options.up_axis`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaneOrientation {
    /// Normal within `classificationAngleDegrees` of up: floor, ceiling, slab.
    Horizontal,
    /// Normal within that angle of perpendicular to up: wall, column face.
    Vertical,
    Sloped,
}

/// Which side the reported normal faces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalSource {
    /// Toward `options.scanner_position`: the scanned (visible) side.
    Scanner,
    /// No scanner given: horizontal planes face up; other planes face along
    /// their largest normal component's positive axis. Says nothing about
    /// which side was scanned.
    Canonical,
}

/// Oriented box of the plane's inlier voxel means within the plane. For
/// vertical and sloped planes `v_axis` points up (along the fall line) and
/// `u_axis` is horizontal; horizontal planes take the minimum-area rectangle.
/// `u_axis x v_axis = normal`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneExtent {
    pub center: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
    pub u_length: f64,
    pub v_length: f64,
    /// Counter-clockwise about the normal, starting at (-u, -v).
    pub corners: [[f64; 3]; 4],
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPlane {
    /// Unit normal; `normal . x + d = 0`.
    pub normal: [f64; 3],
    pub d: f64,
    /// Mean of the inlier voxel means.
    pub centroid: [f64; 3],
    /// Input points inside the inlier voxels.
    pub inlier_points: u64,
    pub inlier_voxels: u32,
    /// Occupied voxel-sized cells after projecting the inliers onto the plane.
    pub area_square_metres: f64,
    /// RMS distance of the inlier voxel means to the plane.
    pub rms_metres: f64,
    pub extent: PlaneExtent,
    pub orientation: PlaneOrientation,
    pub normal_source: NormalSource,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationStats {
    pub input_points: u64,
    pub accepted_points: u64,
    /// Non-finite, or farther than 1e6 m from the positions' frame origin.
    pub rejected_points: u64,
    pub outside_region_points: u64,
    /// Effective voxel edge after any coarsening (the quantised lattice step).
    pub voxel_size_metres: f64,
    pub coarsenings: u32,
    pub voxels: u64,
    pub voxels_with_normals: u64,
    pub seed_voxels: u64,
    pub regions_grown: u64,
    /// Coplanar adjacent regions joined into one.
    pub regions_merged: u64,
    /// Regions refused because their normals turn faster than `maxBendPerMetre`.
    pub curved_regions_rejected: u64,
    /// Regions refused for an area under `minPlaneAreaSquareMetres`.
    pub small_regions_rejected: u64,
    pub planar_voxels: u64,
}

/// Which bounds acted. A bound that acts is always reported here.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationLimits {
    /// The voxel budget doubled the voxel size at least once.
    pub voxel_budget_coarsened: bool,
    /// More planes passed than `maxPlanes`; the smallest were dropped.
    pub plane_limit_hit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationReport {
    pub algorithm: String,
    /// Largest area first; ties by centroid.
    pub planes: Vec<ScanPlane>,
    pub stats: ScanSegmentationStats,
    pub limits: ScanSegmentationLimits,
}
