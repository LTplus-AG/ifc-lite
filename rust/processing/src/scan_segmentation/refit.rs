// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Robust refit, coplanar merging and the curvature test of grown regions.
use super::grow::{refit, Region, UNCLAIMED};
use super::normals::{cross, dot, sub, unit, Normals, Vec3};
use super::options::Params;
use super::voxel::VoxelSet;
use ifc_lite_geometry::UnionFind;

/// Fixed number of median/MAD trims per region.
const ROBUST_PASSES: usize = 2;
/// Scale from the median absolute deviation to a Gaussian sigma.
const MAD_TO_SIGMA: f64 = 1.4826;

fn median(values: &mut [f64]) -> f64 {
    let mid = values.len() / 2;
    let (_, m, _) = values.select_nth_unstable_by(mid, f64::total_cmp);
    *m
}

/// Keep the members whose residual lies within `mad_scale x 1.4826 x MAD` of
/// the median residual (never tighter than half the distance tolerance), and
/// refit on them; released members are unlabelled. None when fewer than three
/// members survive or the survivors are degenerate.
pub(crate) fn robust_refit(
    mut region: Region,
    voxels: &VoxelSet,
    labels: &mut [u32],
    params: &Params,
) -> Option<Region> {
    let mut residuals = Vec::with_capacity(region.voxels.len());
    let mut scratch = Vec::with_capacity(region.voxels.len());
    for _ in 0..ROBUST_PASSES {
        residuals.clear();
        residuals.extend(region.voxels.iter().map(|&i| dot(sub(voxels.means[i as usize], region.centroid), region.normal)));
        scratch.clear();
        scratch.extend_from_slice(&residuals);
        let med = median(&mut scratch);
        for r in scratch.iter_mut() {
            *r = (*r - med).abs();
        }
        let mad = median(&mut scratch);
        let threshold = (params.mad_scale * MAD_TO_SIGMA * mad).max(params.distance / 2.);
        let label = labels[region.voxels[0] as usize];
        let mut kept = Vec::with_capacity(region.voxels.len());
        for (&i, r) in region.voxels.iter().zip(&residuals) {
            if (r - med).abs() <= threshold {
                kept.push(i);
            } else {
                labels[i as usize] = UNCLAIMED;
            }
        }
        if kept.len() < 3 {
            for &i in &kept {
                labels[i as usize] = UNCLAIMED;
            }
            return None;
        }
        debug_assert!(kept.iter().all(|&i| labels[i as usize] == label));
        let fit = refit(voxels, &kept)?;
        region = Region { voxels: kept, normal: fit.normal, centroid: fit.centroid };
    }
    Some(region)
}

/// Joins adjacent regions whose planes agree within the angle tolerance and
/// whose centroids each lie within the distance tolerance of the other's
/// plane. Pairs are visited in ascending order, so the union-find roots, and
/// the merged regions' member order, are deterministic. Returns the merged
/// regions (members ascending) and the number of joins.
pub(crate) fn merge_coplanar(
    regions: Vec<Region>,
    voxels: &VoxelSet,
    labels: &[u32],
    params: &Params,
) -> (Vec<Region>, u64) {
    let mut pairs = Vec::new();
    for i in 0..voxels.len() as u32 {
        let a = labels[i as usize];
        if a == UNCLAIMED {
            continue;
        }
        voxels.for_each_neighbor(i, 1, |j| {
            let b = labels[j as usize];
            if b != UNCLAIMED && a < b {
                pairs.push((a, b));
            }
        });
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut sets = UnionFind::new(regions.len());
    let mut joins = 0;
    for (a, b) in pairs {
        let (ra, rb) = (&regions[a as usize], &regions[b as usize]);
        let coplanar = dot(ra.normal, rb.normal).abs() >= params.cos_angle
            && dot(sub(rb.centroid, ra.centroid), ra.normal).abs() <= params.distance
            && dot(sub(ra.centroid, rb.centroid), rb.normal).abs() <= params.distance;
        if coplanar && sets.union(a, b) {
            joins += 1;
        }
    }
    let mut groups: Vec<Vec<u32>> = vec![Vec::new(); regions.len()];
    for (index, region) in regions.into_iter().enumerate() {
        let root = sets.find(index as u32) as usize;
        groups[root].extend(region.voxels);
    }
    let merged = groups
        .into_iter()
        .filter(|g| !g.is_empty())
        .filter_map(|mut members| {
            members.sort_unstable();
            let fit = refit(voxels, &members)?;
            Some(Region { voxels: members, normal: fit.normal, centroid: fit.centroid })
        })
        .collect();
    (merged, joins)
}

/// An orthonormal in-plane basis (u, v) with u x v = n.
pub(crate) fn plane_basis(n: Vec3) -> (Vec3, Vec3) {
    let helper = if n[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
    let u = unit(cross(helper, n)).unwrap_or([1., 0., 0.]);
    (u, cross(n, u))
}

/// How fast the member normals turn across the region, in radians per metre:
/// the Frobenius norm of the least-squares map from in-plane position to the
/// in-plane tilt of the normal. A plane gives ~0 (noise only); a cylinder of
/// radius r gives 1/r across its axis. Positions are regularised by a voxel's
/// own variance, so a strip one voxel wide cannot divide by zero.
pub(crate) fn bend(region: &Region, voxels: &VoxelSet, normals: &Normals) -> f64 {
    let (u, v) = plane_basis(region.normal);
    let mut samples = Vec::with_capacity(region.voxels.len());
    for &i in &region.voxels {
        if !normals.valid(i) {
            continue;
        }
        let mut ni = normals.normal[i as usize];
        if dot(ni, region.normal) < 0. {
            ni = ni.map(|x| -x);
        }
        let d = sub(voxels.means[i as usize], region.centroid);
        samples.push(([dot(d, u), dot(d, v)], [dot(ni, u), dot(ni, v)]));
    }
    if samples.len() < 3 {
        return 0.;
    }
    let n = samples.len() as f64;
    let (mut pm, mut tm) = ([0.; 2], [0.; 2]);
    for (p, t) in &samples {
        for a in 0..2 {
            pm[a] += p[a] / n;
            tm[a] += t[a] / n;
        }
    }
    let (mut cpp, mut ctp) = ([[0.; 2]; 2], [[0.; 2]; 2]);
    for (p, t) in &samples {
        let p = [p[0] - pm[0], p[1] - pm[1]];
        let t = [t[0] - tm[0], t[1] - tm[1]];
        for a in 0..2 {
            for b in 0..2 {
                cpp[a][b] += p[a] * p[b] / n;
                ctp[a][b] += t[a] * p[b] / n;
            }
        }
    }
    let regulariser = voxels.size * voxels.size / 12.;
    cpp[0][0] += regulariser;
    cpp[1][1] += regulariser;
    let det = cpp[0][0] * cpp[1][1] - cpp[0][1] * cpp[1][0];
    let inverse = [[cpp[1][1] / det, -cpp[0][1] / det], [-cpp[1][0] / det, cpp[0][0] / det]];
    // Frobenius norm of ctp x inverse(cpp).
    let mut norm2 = 0.;
    for row in ctp {
        for (first, second) in inverse[0].iter().zip(&inverse[1]) {
            let value = row[0] * first + row[1] * second;
            norm2 += value * value;
        }
    }
    norm2.sqrt()
}

#[cfg(test)]
#[path = "refit_tests.rs"]
mod tests;
