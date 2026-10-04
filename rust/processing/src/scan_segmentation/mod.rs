// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane detection in point clouds (#6870): scan-to-BIM groundwork.
//!
//! 1. `voxel`: points average into voxels with exact integer sums, so the
//!    result does not depend on point order or chunking; the voxel size
//!    doubles when the working set exceeds its budget.
//! 2. `normals`: PCA over the neighbouring voxel means gives each voxel a
//!    normal and a curvature.
//! 3. `grow`: regions grow from the flattest voxels, gated by angle and
//!    distance to a plane refitted as the region grows.
//! 4. `refit`: a median/MAD trim and refit per region; adjacent coplanar
//!    regions merge through union-find; regions whose normals turn like a
//!    column's are refused.
//! 5. `plane_report`: area, in-plane extent, orientation hint and facing side.
//!
//! Every stage is bounded by the voxel count, which the budget bounds; the
//! report's `limits` says when a budget acted. A clean-room implementation of
//! the published technique (region growing on voxel means); no third-party
//! code was consulted.
mod extent;
mod grow;
mod normals;
mod options;
mod plane_report;
mod refit;
mod report;
mod voxel;

pub use options::{ScanRegion, ScanSegmentationOptions};
pub use report::{
    NormalSource, PlaneExtent, PlaneOrientation, ScanPlane, ScanSegmentationLimits,
    ScanSegmentationReport, ScanSegmentationStats,
};

use grow::{Region, UNCLAIMED};
use options::Params;
use voxel::VoxelGrid;

const ALGORITHM: &str = "ifclite-scan-planes-v1";

/// Segment one buffer of xyz f32 positions (metres).
pub fn segment_scan_points(
    positions: &[f32],
    options: &ScanSegmentationOptions,
) -> Result<ScanSegmentationReport, String> {
    let mut voxelizer = ScanVoxelizer::new(options)?;
    voxelizer.add_points(positions)?;
    voxelizer.segment()
}

/// Streaming entry: add points chunk by chunk (any order, any split) and
/// segment once. The result is identical to one `segment_scan_points` call.
pub struct ScanVoxelizer {
    params: Params,
    grid: VoxelGrid,
}

impl ScanVoxelizer {
    pub fn new(options: &ScanSegmentationOptions) -> Result<Self, String> {
        let params = options.validate()?;
        let grid = VoxelGrid::new(&params);
        Ok(Self { params, grid })
    }

    pub fn add_points(&mut self, positions: &[f32]) -> Result<(), String> {
        self.grid.add(positions)
    }

    pub fn segment(self) -> Result<ScanSegmentationReport, String> {
        let Self { params, grid } = self;
        let mut stats = ScanSegmentationStats {
            input_points: grid.input,
            accepted_points: grid.accepted,
            rejected_points: grid.rejected,
            outside_region_points: grid.outside,
            coordinate_spacing_metres: grid.f32_spacing(),
            voxel_size_metres: grid.size_metres(),
            coarsenings: grid.coarsenings,
            ..Default::default()
        };
        let voxels = grid.finish();
        stats.voxels = voxels.len() as u64;
        let normals = normals::estimate(&voxels, params.rings, params.min_support);
        stats.voxels_with_normals = normals.curvature.iter().filter(|c| c.is_finite()).count() as u64;
        let grow::Grown { regions, mut labels, seeds } = grow::grow(&voxels, &normals, &params);
        stats.seed_voxels = seeds;
        stats.regions_grown = regions.len() as u64;

        let trimmed: Vec<Region> = regions
            .into_iter()
            .filter_map(|r| refit::robust_refit(r, &voxels, &mut labels, &params))
            .collect();
        let regions = relabel(trimmed, &mut labels);
        let (merged, joins) = refit::merge_coplanar(regions, &voxels, &labels, &params);
        stats.regions_merged = joins;

        let mut planes = Vec::new();
        for region in merged {
            if refit::bend(&region, &voxels, &normals) > params.max_bend {
                stats.curved_regions_rejected += 1;
                continue;
            }
            let area = plane_report::area(&region, &voxels);
            if area < params.min_area || area == 0. {
                stats.small_regions_rejected += 1;
                continue;
            }
            stats.planar_voxels += region.voxels.len() as u64;
            planes.push(plane_report::describe(&region, &voxels, area, &params));
        }
        planes.sort_by(|a, b| {
            b.area_square_metres
                .total_cmp(&a.area_square_metres)
                .then_with(|| a.centroid.iter().zip(&b.centroid).fold(std::cmp::Ordering::Equal, |o, (x, y)| o.then(x.total_cmp(y))))
        });
        let limits = ScanSegmentationLimits {
            voxel_budget_coarsened: stats.coarsenings > 0,
            plane_limit_hit: planes.len() > params.max_planes,
            coordinate_precision_degraded: stats.coordinate_spacing_metres > stats.voxel_size_metres / 10.,
        };
        planes.truncate(params.max_planes);
        Ok(ScanSegmentationReport { algorithm: ALGORITHM.into(), planes, stats, limits })
    }
}

/// Number the surviving regions consecutively and point the labels at them.
fn relabel(regions: Vec<Region>, labels: &mut [u32]) -> Vec<Region> {
    labels.fill(UNCLAIMED);
    for (index, region) in regions.iter().enumerate() {
        for &i in &region.voxels {
            labels[i as usize] = index as u32;
        }
    }
    regions
}
