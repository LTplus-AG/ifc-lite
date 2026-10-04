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

/// Axis direction relative to `options.up_axis`, with the plane tolerance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisOrientation {
    /// Axis along up: a column.
    Vertical,
    /// Axis perpendicular to up: a horizontal pipe or beam.
    Horizontal,
    Sloped,
}

/// A detected cylinder (column, pipe). The axis runs from `axis_start` to
/// `axis_end` over the inliers' extent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCylinder {
    pub axis_start: [f64; 3],
    pub axis_end: [f64; 3],
    /// Unit; points up for vertical and sloped axes, along the positive axis
    /// of its largest component for horizontal ones.
    pub axis_direction: [f64; 3],
    pub radius: f64,
    pub length: f64,
    /// Lowest and highest axis end, measured along `up_axis`.
    pub height_range: [f64; 2],
    /// Share of the circumference the inliers cover, in degrees.
    pub arc_degrees: f64,
    pub inlier_points: u64,
    pub inlier_voxels: u32,
    /// RMS radial distance of the inlier voxel means from the surface.
    pub rms_metres: f64,
    pub orientation: AxisOrientation,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationStats {
    pub input_points: u64,
    pub accepted_points: u64,
    /// Non-finite, or farther than 1e6 m from the positions' frame origin.
    pub rejected_points: u64,
    pub outside_region_points: u64,
    /// Spacing of adjacent f32 values at the largest accepted coordinate.
    /// Positions far from their frame origin cannot resolve finer than this.
    pub coordinate_spacing_metres: f64,
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
    /// Smoothly connected non-planar voxel groups large enough to try.
    pub cylinder_groups: u64,
    /// Candidates whose inliers fit a sphere at least as well.
    pub cylinders_rejected_as_spheres: u64,
    /// Candidates whose inliers mostly touch planar voxels: the rounded crease
    /// along a plane junction (wall meets floor), not a free-standing cylinder.
    pub cylinders_rejected_as_creases: u64,
    /// Candidates covering less than `minCylinderArcDegrees`.
    pub cylinders_rejected_for_arc: u64,
    /// Candidates shorter than `minCylinderLengthMetres`.
    pub cylinders_rejected_for_length: u64,
}

/// Which bounds acted. A bound that acts is always reported here.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationLimits {
    /// The voxel budget doubled the voxel size at least once.
    pub voxel_budget_coarsened: bool,
    /// More planes passed than `maxPlanes`; the smallest were dropped.
    pub plane_limit_hit: bool,
    /// The f32 positions are coarser than a tenth of the voxel edge
    /// (`stats.coordinateSpacingMetres`): the data lies too far from its frame
    /// origin, so normals and planes degrade (a room 300 km out splits into
    /// strips). Subtract a local origin before narrowing to f32 and pass it as
    /// `options.origin`.
    pub coordinate_precision_degraded: bool,
    /// More non-planar groups qualified than `maxCylinderGroups`; the
    /// smallest were not examined.
    pub cylinder_group_limit_hit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSegmentationReport {
    pub algorithm: String,
    /// Largest area first; ties by centroid.
    pub planes: Vec<ScanPlane>,
    /// Longest first; ties by axis start.
    pub cylinders: Vec<ScanCylinder>,
    pub stats: ScanSegmentationStats,
    pub limits: ScanSegmentationLimits,
}
