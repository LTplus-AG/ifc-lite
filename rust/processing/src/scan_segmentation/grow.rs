// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Region growing from the flattest voxels.
//!
//! Seeds are voxels with curvature at most `max_seed_curvature`, taken in
//! ascending curvature (ties by voxel order). Noise lifts the curvature of
//! even a flat surface: the 26-voxel neighbourhood cannot tell a slab of
//! noisy voxel means from a bend, and at noise of 0.4 voxel edges (8 mm at a
//! 2 cm voxel) under 2 % of a room's voxels pass 0.02, so nothing grew (#6893).
//! The gate is therefore never tighter than the curvature of the flattest
//! `SEED_FLOOR_SHARE` of the voxels: unchanged on clean data, the flattest
//! surfaces still seed on noisy data. A region grows breadth-first
//! over the 26 neighbours: an unclaimed neighbour joins when its normal lies
//! within the angle tolerance of the region's plane and its mean within the
//! distance tolerance (a voxel too sparse for a normal of its own joins on the
//! distance test alone). The plane is refitted from the member means each time
//! the region grows by a quarter. Every voxel is claimed at most once and each
//! claimed voxel's neighbours are examined once, so the whole pass is bounded
//! by 26 lookups per voxel.
use super::normals::{dot, sub, Fit, Moments, Normals, Vec3};
use super::options::Params;
use super::voxel::VoxelSet;

pub(crate) const UNCLAIMED: u32 = u32::MAX;
/// The seed's own neighbourhood normal is trusted until the region has this
/// many voxels; below it a refit is noisier than the seed fit.
const FIRST_REFIT: usize = 16;
/// Regions this small are released at once: they cannot become a plane and
/// would only block their neighbours.
const MIN_REGION_VOXELS: usize = 3;
/// Share of the voxels with normals that may always seed; see the module docs.
const SEED_FLOOR_SHARE: f64 = 0.05;

/// A set of voxels and their current plane.
#[derive(Clone, Debug)]
pub(crate) struct Region {
    pub voxels: Vec<u32>,
    pub normal: Vec3,
    pub centroid: Vec3,
}

pub(crate) struct Grown {
    pub regions: Vec<Region>,
    /// Region index per voxel, or `UNCLAIMED`.
    pub labels: Vec<u32>,
    pub seeds: u64,
    /// The curvature gate the seeds passed.
    pub seed_curvature: f64,
}

/// Least-squares plane through the members' means; None when degenerate.
pub(crate) fn refit(voxels: &VoxelSet, members: &[u32]) -> Option<Fit> {
    let mut moments = Moments::new(voxels.means[members[0] as usize]);
    for &i in members {
        moments.add(voxels.means[i as usize]);
    }
    moments.fit()
}

/// `max_seed_curvature`, or the curvature of the flattest `SEED_FLOOR_SHARE`
/// of the voxels with normals when that is larger.
fn seed_curvature(normals: &Normals, params: &Params) -> f64 {
    let mut finite: Vec<f64> = normals.curvature.iter().copied().filter(|c| c.is_finite()).collect();
    if finite.is_empty() {
        return params.max_seed_curvature;
    }
    let at = ((finite.len() - 1) as f64 * SEED_FLOOR_SHARE) as usize;
    let floor = *finite.select_nth_unstable_by(at, f64::total_cmp).1;
    params.max_seed_curvature.max(floor)
}

pub(crate) fn grow(voxels: &VoxelSet, normals: &Normals, params: &Params) -> Grown {
    let seed_curvature = seed_curvature(normals, params);
    let mut seeds: Vec<u32> = (0..voxels.len() as u32)
        .filter(|&i| normals.curvature[i as usize] <= seed_curvature)
        .collect();
    seeds.sort_by(|&a, &b| normals.curvature[a as usize].total_cmp(&normals.curvature[b as usize]).then(a.cmp(&b)));
    let mut labels = vec![UNCLAIMED; voxels.len()];
    let mut regions = Vec::new();
    for &seed in &seeds {
        if labels[seed as usize] != UNCLAIMED {
            continue;
        }
        let label = regions.len() as u32;
        let mut members = vec![seed];
        labels[seed as usize] = label;
        let mut moments = Moments::new(voxels.means[seed as usize]);
        moments.add(voxels.means[seed as usize]);
        let (mut normal, mut centroid) = (normals.normal[seed as usize], voxels.means[seed as usize]);
        let mut next_refit = FIRST_REFIT;
        let mut cursor = 0;
        while cursor < members.len() {
            let current = members[cursor];
            cursor += 1;
            voxels.for_each_neighbor(current, 1, |j| {
                let ju = j as usize;
                if labels[ju] != UNCLAIMED
                    || (normals.valid(j) && dot(normals.normal[ju], normal).abs() < params.cos_angle)
                    || dot(sub(voxels.means[ju], centroid), normal).abs() > params.distance
                {
                    return;
                }
                labels[ju] = label;
                members.push(j);
                moments.add(voxels.means[ju]);
            });
            if members.len() >= next_refit {
                if let Some(fit) = moments.fit() {
                    (normal, centroid) = (fit.normal, fit.centroid);
                }
                next_refit = members.len() + members.len() / 4;
            }
        }
        if members.len() < MIN_REGION_VOXELS {
            for &i in &members {
                labels[i as usize] = UNCLAIMED;
            }
            continue;
        }
        if let Some(fit) = moments.fit() {
            (normal, centroid) = (fit.normal, fit.centroid);
        }
        regions.push(Region { voxels: members, normal, centroid });
    }
    Grown { regions, labels, seeds: seeds.len() as u64, seed_curvature }
}
