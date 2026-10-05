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
/// point more than 11 degrees (RMS over 5 degree bins, the ends of each
/// visible arc trimmed) off the radial direction, or turn under 0.6 radians
/// per radian of position. The cylinder acceptance table
/// (`tests/scan_cylinder_acceptance.rs`) guards both bars.
/// Nothing measurable (no normals, no comparable bins) is not evidence of
/// facets.
pub(crate) fn looks_faceted(
    cylinder: &Cylinder,
    inliers: &[u32],
    voxels: &VoxelSet,
    rings: i32,
    normal_of: &dyn Fn(u32) -> Option<Vec3>,
) -> bool {
    radial_deviation_degrees(cylinder, inliers, voxels, rings, normal_of).is_some_and(|d| d > MAX_RADIAL_DEVIATION_DEGREES)
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
    rings: i32,
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
    let occupied: [bool; MAX_TURN_BINS] = std::array::from_fn(|k| sums[k][0] != 0. || sums[k][1] != 0.);
    // Where the visible arc ends, voxel normals come from a one-sided
    // neighbourhood and lean toward the arc (measured: about 16 degrees RMS in
    // the end bins, falling to about 4 beyond the neighbourhood). Trim
    // `rings` voxels of arc plus one bin from each end of every visible run;
    // gaps narrower than one voxel of arc are sampling, not ends.
    let bin_width = TAU / MAX_TURN_BINS as f64;
    let voxel_arc = voxels.size / cylinder.radius;
    let bridge = (voxel_arc / bin_width).ceil() as usize;
    let trim = (f64::from(rings) * voxel_arc / bin_width).ceil() as usize + 1;
    let to_end = |k: usize, step_sign: isize| -> usize {
        let (mut last, mut empty) = (0, 0);
        for step in 1..MAX_TURN_BINS {
            let b = (k as isize + step_sign * step as isize).rem_euclid(MAX_TURN_BINS as isize) as usize;
            if occupied[b] {
                (last, empty) = (step, 0);
            } else {
                empty += 1;
                if empty > bridge {
                    return last;
                }
            }
        }
        MAX_TURN_BINS
    };
    let deviations: Vec<f64> = (0..MAX_TURN_BINS)
        .filter(|&k| occupied[k] && to_end(k, 1).min(to_end(k, -1)) >= trim)
        .map(|k| wrap(sums[k][3].atan2(sums[k][2]) - sums[k][1].atan2(sums[k][0])))
        .collect();
    (!deviations.is_empty()).then(|| (deviations.iter().map(|d| d * d).sum::<f64>() / deviations.len() as f64).sqrt().to_degrees())
}

/// Inlier voxels over the voxels the claimed patch (length by arc) should
/// hold: about 1 on a scanned surface (a column occluded low down 0.56..0.69),
/// 0.1..0.4 for loose fits threaded through what is left of a group after its
/// best candidate was refused.
pub(crate) fn coverage(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet, arc_degrees: f64) -> f64 {
    let frame = Frame::new(cylinder, inliers, voxels);
    let along = |i: &u32| dot(sub(voxels.means[*i as usize], cylinder.point), cylinder.axis);
    let hi = inliers.iter().map(along).fold(f64::NEG_INFINITY, f64::max);
    let rows = (hi - frame.lo) / voxels.size + 1.;
    let around = (arc_degrees.to_radians() * cylinder.radius / voxels.size).max(1.);
    inliers.len() as f64 / (rows * around)
}

/// Share of the candidate's axial slices in which a planar voxel lies inside
/// the circle (closer to the axis than radius minus tolerance). A scanned flat
/// surface cannot lie inside a solid column or pipe (the wall behind a column
/// is never seen), but the walls of an inside corner cut through the circle a
/// rounded crease fits: on a real apartment scan 0.67 of such a candidate's
/// slices were pierced, against 0 for every real round surface measured.
pub(crate) fn pierced_share(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet, planar: &[bool], tolerance: f64) -> f64 {
    let frame = Frame::new(cylinder, inliers, voxels);
    let core = cylinder.radius - tolerance;
    if core <= 0. {
        return 0.;
    }
    let span = frame.thickness * frame.slices as f64;
    let along = |p: Vec3| dot(sub(p, cylinder.point), cylinder.axis);
    let mut pierced = vec![false; frame.slices];
    let mut visit = |k: u32| {
        let p = voxels.means[k as usize];
        let t = along(p) - frame.lo;
        if planar[k as usize] && (0. ..span).contains(&t) && cylinder.radial(p).0 < core {
            pierced[frame.slice(cylinder, p)] = true;
        }
    };
    // Visit the voxels in the candidate's bounding box (one voxel of margin),
    // or every voxel when the box would hold more keys than there are voxels.
    let ends = [frame.lo, frame.lo + span].map(|t| std::array::from_fn::<f64, 3, _>(|a| cylinder.point[a] + t * cylinder.axis[a]));
    let key = |v: f64| (v / voxels.size).floor();
    let lo: [f64; 3] = std::array::from_fn(|a| key(ends[0][a].min(ends[1][a]) - cylinder.radius) - 1.);
    let hi: [f64; 3] = std::array::from_fn(|a| key(ends[0][a].max(ends[1][a]) + cylinder.radius) + 1.);
    let cells: f64 = (0..3).map(|a| hi[a] - lo[a] + 1.).product();
    if cells > voxels.len() as f64 {
        (0..voxels.len() as u32).for_each(&mut visit);
    } else {
        for x in lo[0] as i32..=hi[0] as i32 {
            for y in lo[1] as i32..=hi[1] as i32 {
                for z in lo[2] as i32..=hi[2] as i32 {
                    if let Some(k) = voxels.lookup([x, y, z]) {
                        visit(k);
                    }
                }
            }
        }
    }
    pierced.iter().filter(|p| **p).count() as f64 / frame.slices as f64
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
