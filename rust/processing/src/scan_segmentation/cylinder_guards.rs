// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shape tests that tell a round surface from look-alikes, once a candidate
//! has passed the inlier share, sphere, arc and length tests.
//!
//! Both work on a grid of axial slices (3 voxels thick) by angular bins about
//! the axis, so they measure angles, not voxel steps, and behave the same for
//! a pipe of two voxels' radius and a column of eighty.
use super::cylinder_fit::Cylinder;
use super::normals::{cross, dot, sub, Vec3};
use super::refit::plane_basis;
use super::voxel::VoxelSet;
use std::f64::consts::{PI, TAU};

const SLICE_VOXELS: f64 = 3.;
/// The turning test compares angular bins at least 5 degrees and at least one
/// voxel of arc wide: narrower bins on a thin pipe hold sub-voxel jitter.
const MIN_TURN_BIN: f64 = 0.0873; // 5 degrees
const MAX_TURN_BINS: usize = 72;
/// 10 degree bins for the slice agreement test.
const ARC_BINS: usize = 36;
/// Consecutive occupied turn bins further apart than this are not compared.
const MAX_TURN_GAP_BINS: usize = 3;
/// A slice agrees with the reference when this share of its bins lies in the
/// reference arc (widened by one bin each side).
const SLICE_CONTAINED: f64 = 0.75;
/// Facet test bounds; see `looks_faceted`.
const MIN_TURNING_RATIO: f64 = 0.6;
const MAX_RADIAL_DEVIATION_DEGREES: f64 = 11.;

fn wrap(d: f64) -> f64 {
    (d + PI).rem_euclid(TAU) - PI
}

/// Axial slice index, position angle and its basis for each inlier.
struct Frame {
    u: Vec3,
    v: Vec3,
    lo: f64,
    thickness: f64,
    slices: usize,
}

impl Frame {
    fn new(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet) -> Self {
        let (u, _) = plane_basis(cylinder.axis);
        let v = cross(cylinder.axis, u);
        let along = |i: u32| dot(sub(voxels.means[i as usize], cylinder.point), cylinder.axis);
        let (lo, hi) = inliers.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &i| (lo.min(along(i)), hi.max(along(i))));
        let thickness = SLICE_VOXELS * voxels.size;
        // Bounded: never more slices than inliers.
        let slices = (((hi - lo) / thickness) as usize + 1).min(inliers.len().max(1));
        Self { u, v, lo, thickness, slices }
    }
    fn slice(&self, cylinder: &Cylinder, p: Vec3) -> usize {
        let t = dot(sub(p, cylinder.point), cylinder.axis);
        (((t - self.lo) / self.thickness) as usize).min(self.slices - 1)
    }
    fn angle(&self, d: Vec3) -> f64 {
        dot(d, self.v).atan2(dot(d, self.u))
    }
}

fn bin(angle: f64, bins: usize) -> usize {
    ((angle.rem_euclid(TAU) / TAU * bins as f64) as usize).min(bins - 1)
}

/// How far the normal turns per radian of position around the axis: the
/// median over consecutive occupied angular bins (5 degrees, or one voxel of
/// arc when that is wider) within each slice, comparing
/// the bins' mean position and mean normal angles. About 1 on a cylinder,
/// about 0 across flat facets (constant normal per facet). None when no two
/// bins are comparable (nothing measured: the caller lets the candidate pass).
fn turning_ratio(
    cylinder: &Cylinder,
    inliers: &[u32],
    voxels: &VoxelSet,
    normal_of: &dyn Fn(u32) -> Option<Vec3>,
) -> Option<f64> {
    let frame = Frame::new(cylinder, inliers, voxels);
    let width = MIN_TURN_BIN.max(voxels.size / cylinder.radius);
    let bins = ((TAU / width) as usize).clamp(4, MAX_TURN_BINS);
    // Per (slice, bin): summed unit vectors of position and normal angles.
    let mut sums = vec![[0_f64; 4]; frame.slices * bins];
    for &i in inliers {
        let Some(normal) = normal_of(i) else { continue };
        let p = voxels.means[i as usize];
        let (_, radial) = cylinder.radial(p);
        let normal = if dot(normal, radial) < 0. { normal.map(|x| -x) } else { normal };
        let (position, facing) = (frame.angle(sub(p, cylinder.point)), frame.angle(normal));
        let cell = &mut sums[frame.slice(cylinder, p) * bins + bin(position, bins)];
        cell[0] += position.cos();
        cell[1] += position.sin();
        cell[2] += facing.cos();
        cell[3] += facing.sin();
    }
    let mut ratios = Vec::new();
    for slice in sums.chunks_exact(bins) {
        let occupied: Vec<usize> = (0..bins).filter(|&b| slice[b][0] != 0. || slice[b][1] != 0.).collect();
        for pair in occupied.windows(2) {
            let (a, b) = (slice[pair[0]], slice[pair[1]]);
            if pair[1] - pair[0] > MAX_TURN_GAP_BINS {
                continue;
            }
            let turn = wrap(b[1].atan2(b[0]) - a[1].atan2(a[0]));
            if turn.abs() > 1e-3 {
                ratios.push(wrap(b[3].atan2(b[2]) - a[3].atan2(a[2])) / turn);
            }
        }
    }
    if ratios.is_empty() {
        return None;
    }
    let mid = ratios.len() / 2;
    Some(*ratios.select_nth_unstable_by(mid, f64::total_cmp).1)
}

/// Whether the candidate's normals fail to behave as a round surface's: they
/// point more than 11 degrees (RMS over 5 degree bins) off the radial
/// direction, or turn under 0.6 radians per radian of position. Real round
/// surfaces measured at most 9.3 degrees and at least 0.68; flat facets,
/// corner clutter and loose fits at least 11.8 degrees or at most 0.49.
/// Nothing measurable (no normals, no comparable bins) is not evidence of
/// facets.
pub(crate) fn looks_faceted(
    cylinder: &Cylinder,
    inliers: &[u32],
    voxels: &VoxelSet,
    normal_of: &dyn Fn(u32) -> Option<Vec3>,
) -> bool {
    radial_deviation_degrees(cylinder, inliers, voxels, normal_of).is_some_and(|d| d > MAX_RADIAL_DEVIATION_DEGREES)
        || turning_ratio(cylinder, inliers, voxels, normal_of).is_some_and(|ratio| ratio < MIN_TURNING_RATIO)
}

/// RMS over 5 degree bins (all heights pooled) of the angle between the
/// bin's mean normal and its mean radial direction, in degrees: whether the
/// normals point away from the axis, as on a round surface. Measured at most
/// 9.3 on real pipes and columns (half, third, wall-flush, 8 mm noise) and at
/// least 11.8 on flat facets, corner clutter and loose fits. None without
/// normals.
fn radial_deviation_degrees(
    cylinder: &Cylinder,
    inliers: &[u32],
    voxels: &VoxelSet,
    normal_of: &dyn Fn(u32) -> Option<Vec3>,
) -> Option<f64> {
    let frame = Frame::new(cylinder, inliers, voxels);
    let mut sums = [[0_f64; 4]; MAX_TURN_BINS];
    for &i in inliers {
        let Some(normal) = normal_of(i) else { continue };
        let p = voxels.means[i as usize];
        let (_, radial) = cylinder.radial(p);
        let normal = if dot(normal, radial) < 0. { normal.map(|x| -x) } else { normal };
        let (position, facing) = (frame.angle(sub(p, cylinder.point)), frame.angle(normal));
        let cell = &mut sums[bin(position, MAX_TURN_BINS)];
        cell[0] += position.cos();
        cell[1] += position.sin();
        cell[2] += facing.cos();
        cell[3] += facing.sin();
    }
    let deviations: Vec<f64> = sums
        .iter()
        .filter(|c| c[0] != 0. || c[1] != 0.)
        .map(|c| wrap(c[3].atan2(c[2]) - c[1].atan2(c[0])))
        .collect();
    (!deviations.is_empty()).then(|| (deviations.iter().map(|d| d * d).sum::<f64>() / deviations.len() as f64).sqrt().to_degrees())
}

/// Share of slices whose arc agrees with the widest slice's arc (10 degree
/// bins, mostly inside it). A column occluded below a table shows a smaller
/// arc low down, but inside the arc seen higher up: every slice agrees.
/// Clutter shows different fragments at different heights: few agree.
pub(crate) fn slice_agreement(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet) -> f64 {
    let frame = Frame::new(cylinder, inliers, voxels);
    let mut slices = vec![[false; ARC_BINS]; frame.slices];
    for &i in inliers {
        let p = voxels.means[i as usize];
        slices[frame.slice(cylinder, p)][bin(frame.angle(sub(p, cylinder.point)), ARC_BINS)] = true;
    }
    let count = |s: &[bool; ARC_BINS]| s.iter().filter(|b| **b).count();
    let Some(widest) = slices.iter().max_by_key(|s| count(s)) else { return 1. };
    let reference: [bool; ARC_BINS] = std::array::from_fn(|b| widest[(b + ARC_BINS - 1) % ARC_BINS] || widest[b] || widest[(b + 1) % ARC_BINS]);
    let (mut seen, mut agree) = (0, 0);
    for s in &slices {
        let n = count(s);
        if n == 0 {
            continue;
        }
        seen += 1;
        let inside = (0..ARC_BINS).filter(|&b| s[b] && reference[b]).count();
        if inside as f64 >= SLICE_CONTAINED * n as f64 {
            agree += 1;
        }
    }
    if seen == 0 { 1. } else { agree as f64 / seen as f64 }
}

#[cfg(test)]
#[path = "cylinder_guards_tests.rs"]
mod tests;
