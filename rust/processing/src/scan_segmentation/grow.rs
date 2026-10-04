// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Region growing from the flattest voxels.
//!
//! Seeds are voxels with curvature at most `max_seed_curvature`, taken in
//! ascending curvature (ties by voxel order). A region grows breadth-first
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
}

/// Least-squares plane through the members' means; None when degenerate.
pub(crate) fn refit(voxels: &VoxelSet, members: &[u32]) -> Option<Fit> {
    let mut moments = Moments::new(voxels.means[members[0] as usize]);
    for &i in members {
        moments.add(voxels.means[i as usize]);
    }
    moments.fit()
}

pub(crate) fn grow(voxels: &VoxelSet, normals: &Normals, params: &Params) -> Grown {
    let mut seeds: Vec<u32> = (0..voxels.len() as u32)
        .filter(|&i| normals.curvature[i as usize] <= params.max_seed_curvature)
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
    Grown { regions, labels, seeds: seeds.len() as u64 }
}
