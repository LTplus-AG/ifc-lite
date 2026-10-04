// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Every tunable of scan segmentation, with documented defaults and bounds.
//!
//! All coordinates (`scanner_position`, `region`) are in the frame of the
//! supplied positions, in metres; `origin` is added to every output
//! coordinate, so f32 decode-relative positions can report in their
//! f64 source frame.
use serde::{Deserialize, Serialize};

/// Hard bounds, not options: they keep the integer voxel sums exact.
pub(crate) const MAX_POINTS: u64 = 100_000_000;
/// Points farther than this from the positions' frame origin are rejected
/// (f32 positions lose centimetre precision beyond about 1e5 m anyway).
pub(crate) const MAX_ABS_COORDINATE: f64 = 1e6;
/// The voxel budget may double the voxel size at most this many times.
pub(crate) const MAX_COARSENINGS: u32 = 16;

/// Axis-aligned crop box in the positions' frame (inclusive).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRegion {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ScanSegmentationOptions {
    /// Edge of the averaging voxel. Default 0.03 m; 0.005..=1.
    pub voxel_size_metres: f64,
    /// Voxel budget: past it the voxel size doubles and existing voxels fold
    /// into the coarser lattice (exactly). Default 1,500,000; 1,000..=8,000,000.
    /// Working memory is roughly 180 bytes per voxel: the 8,000,000 maximum
    /// with two normal rings measured 1.42 GB native RSS, too much for a
    /// browser tab, so wasm callers should stay near the default.
    pub max_voxels: u32,
    /// Neighbourhood for voxel normals: 1 = the 26 neighbours, 2 = 124.
    /// Default 1.
    pub normal_neighbor_rings: u32,
    /// Occupied voxels (including the voxel itself) a normal needs. Default 6.
    pub min_neighbors: u32,
    /// Seeds are voxels whose curvature (smallest eigenvalue / eigenvalue sum
    /// of the neighbourhood scatter) is at most this. Default 0.02.
    pub max_seed_curvature: f64,
    /// A voxel joins a region when its normal is within this of the region's
    /// plane; also the coplanar-merge angle. Default 10 degrees; (0, 45].
    pub max_normal_angle_degrees: f64,
    /// ... and its mean lies within this of the region's plane; also the
    /// coplanar-merge offset. Default 0.02 m.
    pub max_plane_distance_metres: f64,
    /// Robust refit keeps voxels within `mad_scale * 1.4826 * MAD` of the
    /// median residual, never tighter than half `max_plane_distance_metres`.
    /// Default 2.5.
    pub mad_scale: f64,
    /// A region whose voxel normals turn faster than this across it (1 /
    /// radius of curvature) is a curved surface such as a column, not a plane.
    /// Default 1.0 per metre.
    pub max_bend_per_metre: f64,
    /// Planes with a smaller estimated area are dropped. Default 0.25 m^2.
    pub min_plane_area_square_metres: f64,
    /// Horizontal within this of `up_axis`, vertical within this of
    /// perpendicular, sloped otherwise. Default 10 degrees.
    pub classification_angle_degrees: f64,
    /// Up direction of the positions' frame. Default +Z ([0, 0, 1]); the
    /// viewer's Y-up reservoir sample passes [0, 1, 0].
    pub up_axis: [f64; 3],
    /// Scanner station: when given, every plane normal faces it.
    pub scanner_position: Option<[f64; 3]>,
    /// Added to every output coordinate. Default [0, 0, 0].
    pub origin: [f64; 3],
    /// Only points inside this box take part.
    pub region: Option<ScanRegion>,
    /// At most this many planes are reported, largest first. Default 10,000.
    pub max_planes: u32,
}

impl Default for ScanSegmentationOptions {
    fn default() -> Self {
        Self {
            voxel_size_metres: 0.03,
            max_voxels: 1_500_000,
            normal_neighbor_rings: 1,
            min_neighbors: 6,
            max_seed_curvature: 0.02,
            max_normal_angle_degrees: 10.,
            max_plane_distance_metres: 0.02,
            mad_scale: 2.5,
            max_bend_per_metre: 1.,
            min_plane_area_square_metres: 0.25,
            classification_angle_degrees: 10.,
            up_axis: [0., 0., 1.],
            scanner_position: None,
            origin: [0.; 3],
            region: None,
            max_planes: 10_000,
        }
    }
}

/// Validated options with derived constants.
#[derive(Debug, Clone)]
pub(crate) struct Params {
    pub base_size_quanta: i64,
    pub max_voxels: usize,
    pub rings: i32,
    pub min_support: usize,
    pub max_seed_curvature: f64,
    pub cos_angle: f64,
    pub distance: f64,
    pub mad_scale: f64,
    pub max_bend: f64,
    pub min_area: f64,
    pub cos_class: f64,
    pub sin_class: f64,
    pub up: [f64; 3],
    pub scanner: Option<[f64; 3]>,
    pub origin: [f64; 3],
    pub region: Option<ScanRegion>,
    pub max_planes: usize,
}

fn within(value: f64, lo: f64, hi: f64) -> bool {
    value.is_finite() && value >= lo && value <= hi
}

/// `lo < value <= hi`; false for NaN.
fn above(value: f64, lo: f64, hi: f64) -> bool {
    value > lo && value <= hi
}

impl ScanSegmentationOptions {
    pub(crate) fn validate(&self) -> Result<Params, String> {
        let o = self;
        let fail = |what: &str| Err(format!("Scan segmentation option {what}"));
        if !within(o.voxel_size_metres, 0.005, 1.) {
            return fail("voxelSizeMetres must be within 0.005..=1");
        }
        if !(1_000..=8_000_000).contains(&o.max_voxels) {
            return fail("maxVoxels must be within 1,000..=8,000,000");
        }
        let rings = o.normal_neighbor_rings;
        let neighbourhood = (2 * rings + 1).pow(3);
        if !(1..=2).contains(&rings) || o.min_neighbors < 4 || o.min_neighbors > neighbourhood {
            return fail("normalNeighborRings must be 1 or 2 and minNeighbors 4..=(2*rings+1)^3");
        }
        if !above(o.max_seed_curvature, 0., 1. / 3.) {
            return fail("maxSeedCurvature must be within (0, 1/3]");
        }
        if !above(o.max_normal_angle_degrees, 0., 45.) || !above(o.classification_angle_degrees, 0., 45.) {
            return fail("angles must be within (0, 45] degrees");
        }
        if !above(o.max_plane_distance_metres, 0., 1.)
            || !above(o.mad_scale, 0., 10.)
            || !above(o.max_bend_per_metre, 0., 1e3)
            || !within(o.min_plane_area_square_metres, 0., 1e6)
        {
            return fail("distance (0, 1] m, madScale (0, 10], maxBendPerMetre (0, 1000] and area 0..=1e6 m^2 are required");
        }
        let up_length = o.up_axis.iter().map(|v| v * v).sum::<f64>().sqrt();
        if !up_length.is_finite() || up_length < 1e-9 {
            return fail("upAxis must be a finite non-zero vector");
        }
        let bounded = |p: &[f64; 3], limit: f64| p.iter().all(|v| within(*v, -limit, limit));
        if o.scanner_position.is_some_and(|p| !bounded(&p, MAX_ABS_COORDINATE)) || !bounded(&o.origin, 1e12) {
            return fail("scannerPosition must lie within 1e6 m and origin within 1e12 m");
        }
        if let Some(r) = o.region {
            if !bounded(&r.min, 1e12) || !bounded(&r.max, 1e12) || (0..3).any(|a| r.min[a] > r.max[a]) {
                return fail("region needs finite min <= max");
            }
        }
        if !(1..=100_000).contains(&o.max_planes) {
            return fail("maxPlanes must be within 1..=100,000");
        }
        let class = o.classification_angle_degrees.to_radians();
        Ok(Params {
            base_size_quanta: (o.voxel_size_metres * super::voxel::QUANTA_PER_METRE).round() as i64,
            max_voxels: o.max_voxels as usize,
            rings: rings as i32,
            min_support: o.min_neighbors as usize,
            max_seed_curvature: o.max_seed_curvature,
            cos_angle: o.max_normal_angle_degrees.to_radians().cos(),
            distance: o.max_plane_distance_metres,
            mad_scale: o.mad_scale,
            max_bend: o.max_bend_per_metre,
            min_area: o.min_plane_area_square_metres,
            cos_class: class.cos(),
            sin_class: class.sin(),
            up: o.up_axis.map(|v| v / up_length),
            scanner: o.scanner_position,
            origin: o.origin,
            region: o.region,
            max_planes: o.max_planes as usize,
        })
    }
}
