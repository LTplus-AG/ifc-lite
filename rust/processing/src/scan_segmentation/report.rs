// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Measured output of scan segmentation. Coordinates are in the positions'
//! frame plus `options.origin`, in metres.
use serde::{Deserialize, Serialize};

/// Classification hint relative to `options.up_axis`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaneOrientation {
    /// Normal within `classificationAngleDegrees` of up: floor, ceiling, slab.
    Horizontal,
    /// Normal within that angle of perpendicular to up: wall, column face.
    Vertical,
    Sloped,
}

/// Which side the reported normal faces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisOrientation {
    /// Axis along up: a column.
    Vertical,
    /// Axis perpendicular to up: a horizontal pipe or beam.
    Horizontal,
    Sloped,
}

/// The faces of a polygonal (prism) column: a regular polygon of `faces`
/// sides about the cylinder's axis, `radius` being its circumradius (axis to
/// corner).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFacets {
    /// Number of sides of the whole polygon (6 or more), seen or not.
    pub faces: u32,
    /// Unit outward normal of one face, perpendicular to the axis; the others
    /// follow at multiples of 360 / `faces` degrees about the axis. Of the
    /// equivalent choices, the one nearest the first in-plane basis direction
    /// (see the guide) is reported, so it is deterministic.
    pub face_normal: [f64; 3],
    /// Distance from the axis to each face (inradius).
    pub apothem: f64,
}

/// A detected cylinder (column, pipe). The axis runs from `axis_start` to
/// `axis_end` over the inliers' extent. A polygonal column of six or more
/// faces is reported here too, with `faceted` set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCylinder {
    pub axis_start: [f64; 3],
    pub axis_end: [f64; 3],
    /// Unit; points up for vertical and sloped axes, along the positive axis
    /// of its largest component for horizontal ones.
    pub axis_direction: [f64; 3],
    /// Radius; for a faceted column the circumradius (axis to corner).
    pub radius: f64,
    pub length: f64,
    /// Lowest and highest axis end, measured along `up_axis`.
    pub height_range: [f64; 2],
    /// Share of the circumference the inliers cover, in degrees. For pieces
    /// joined across a density gap, the larger piece's arc (a lower bound).
    pub arc_degrees: f64,
    pub inlier_points: u64,
    pub inlier_voxels: u32,
    /// RMS radial distance of the inlier voxel means from the surface.
    pub rms_metres: f64,
    pub orientation: AxisOrientation,
    /// Set for a polygonal column (a ring of six or more flat faces); None
    /// for a round surface.
    pub faceted: Option<ScanFacets>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// The curvature gate the seeds passed: `maxSeedCurvature`, or, when noise
    /// lifts even flat voxels above it, the curvature of the flattest 5 %.
    pub seed_curvature: f64,
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
    /// Groups whose best RANSAC candidate fit under `minCylinderInlierFraction`
    /// of the group (or no pair defined a candidate at all).
    pub cylinder_candidates_below_share: u64,
    /// Candidates whose least-squares refit kept too few inliers or degenerated.
    pub cylinder_refits_failed: u64,
    /// Refits outside the radius range; every group when the range is empty
    /// (an unset minimum, two voxels, above `maxCylinderRadiusMetres`).
    pub cylinders_rejected_for_radius: u64,
    /// Candidates whose inliers cover under 40 % of the patch their length and
    /// arc claim: loose fits through scattered voxels, not a surface.
    pub cylinders_rejected_as_sparse: u64,
    /// Candidates whose normals do not behave as a round surface's: they
    /// point more than 11 degrees (RMS over 5 degree bins) away from the
    /// radial direction, or turn under 0.6 radians per radian of position.
    /// Flat facets meeting at an angle (a pier, a chamfered corner) and
    /// clutter in a wall corner.
    pub cylinders_rejected_as_facets: u64,
    /// Candidates whose inside is crossed by a scanned plane over more than
    /// half their length: the walls of an inside corner cutting through the
    /// circle a rounded crease fits, not a solid column or pipe.
    pub cylinders_rejected_as_pierced: u64,
    /// Candidates where fewer than half the axial slices agree with the
    /// widest slice's arc: fragments at different heights (clutter in a wall
    /// corner), not one round surface.
    pub cylinders_rejected_for_uneven_arc: u64,
    /// Coaxial pieces of one radius joined across a band without points.
    pub cylinders_joined_across_gaps: u64,
    /// The same surface found twice (across groups or tries); the better
    /// supported one is kept.
    pub cylinders_rejected_as_duplicates: u64,
    /// Candidates covering less than `minCylinderArcDegrees`.
    pub cylinders_rejected_for_arc: u64,
    /// Candidates shorter than `minCylinderLengthMetres`.
    pub cylinders_rejected_for_length: u64,
    /// Rings of adjacent vertical planes around a common axis, examined as
    /// wide round or polygonal columns.
    pub plane_rings: u64,
    /// Rings that were neither round nor a regular polygon of six or more
    /// similar faces turning at least 120 degrees in all: they stay planes.
    pub plane_rings_rejected_as_irregular: u64,
    /// Rings with scanned surface inside their footprint (a bay or a niche
    /// seen from the room, whose floor runs inside): not a solid column.
    pub plane_rings_rejected_as_hollow: u64,
    /// Planes removed from `planes` because they lie on a reported cylinder
    /// or are the faces of a faceted column: a surface is reported once.
    pub planes_absorbed_into_cylinders: u64,
}

/// Which bounds acted. A bound that acts is always reported here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
