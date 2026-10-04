// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinders among the voxels no plane claimed (#6870).
//!
//! 1. Voxels clear of every plane (neither planar nor next to a planar
//!    voxel) with normals form groups, connected over the 26 neighbours where
//!    adjacent normals turn by at most 35 degrees.
//! 2. Per group, largest first: a seeded RANSAC. Two voxels whose normals are
//!    at least 30 degrees from parallel define a candidate. The axis is
//!    `n1 x n2`, and the axis line and radius come from the closest approach
//!    of the two normal lines. Each draw is scored on an evenly strided
//!    subsample.
//! 3. The best candidate is refitted by least squares (`cylinder_fit`) and
//!    kept when the refit fits at least `min_cylinder_inlier_fraction` of the
//!    group. It is refused when its radius is out of range (the minimum
//!    defaults to two voxels), when a sphere fits its inliers as well, when
//!    they cover less than the minimum arc, when they are shorter than the
//!    minimum length, or when they are sparser than one voxel per voxel step
//!    along the axis. Its inliers then leave the group, and the next candidate
//!    is sought; at most `MAX_PER_GROUP` tries per group. Every exit is
//!    counted in the stats.
//! 4. Near-identical cylinders (one surface found twice, across groups or
//!    tries) are reduced to the best supported one.
//!
//! Every loop is bounded: groups by `max_cylinder_groups`, draws by
//! `cylinder_draws`, scoring by `cylinder_score_sample`, refits by fixed pass
//! counts. The RNG is seeded per group from its first voxel, and voxels are
//! ordered by key, so results do not depend on point order.
use super::cylinder_fit::{arc_degrees, refine, sphere_rms, Cylinder};
use super::normals::{canonical_sign, cross, dot, sub, unit, Normals, Vec3};
use super::options::{CylinderParams, Params};
use super::report::{AxisOrientation, ScanCylinder, ScanSegmentationStats};
use super::voxel::VoxelSet;

const GROUP_COS: f64 = 0.819; // cos 35 degrees
const MIN_GROUP_VOXELS: usize = 20;
const MAX_PER_GROUP: usize = 4;
/// Two normals closer than 30 degrees to parallel (or antiparallel) cross
/// too shallowly for a stable axis and radius: noise of a few degrees moves
/// their crossing by a radius or more.
const MIN_PAIR_SIN: f64 = 0.5; // sin 30 degrees
/// Near-identical cylinders (same axis line within this angle, axis lines
/// within half the larger radius, radii within this ratio, overlapping
/// extents) are one surface found twice; only the best supported is kept.
const DUPLICATE_SIN: f64 = 0.087; // sin 5 degrees
const DUPLICATE_RADIUS_RATIO: f64 = 1.25;

/// SplitMix64, as in the test generator: tiny and identical everywhere.
struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) % n as u64) as usize
    }
}

/// Smoothly connected groups of voxels clear of every plane, with at least
/// `MIN_GROUP_VOXELS`,
/// largest first (ties by first voxel).
fn groups(voxels: &VoxelSet, normals: &Normals, planar: &[bool]) -> Vec<Vec<u32>> {
    // Voxels on or next to a plane stay out: the rounded crease along a
    // wall/floor junction would otherwise chain every column standing near a
    // wall into one room-sized group whose cylinder share is too low (a column
    // 3 cm from a corner was never found), and would pass for a thin pipe.
    let eligible: Vec<bool> = (0..voxels.len() as u32)
        .map(|i| {
            let mut touches = planar[i as usize];
            voxels.for_each_neighbor(i, 1, |j| touches |= planar[j as usize]);
            !touches && normals.valid(i)
        })
        .collect();
    let mut seen = vec![false; voxels.len()];
    let mut out = Vec::new();
    for start in 0..voxels.len() as u32 {
        if seen[start as usize] || !eligible[start as usize] {
            continue;
        }
        seen[start as usize] = true;
        let mut members = vec![start];
        let mut cursor = 0;
        while cursor < members.len() {
            let current = members[cursor];
            cursor += 1;
            let n = normals.normal[current as usize];
            voxels.for_each_neighbor(current, 1, |j| {
                let ju = j as usize;
                if !seen[ju] && eligible[ju] && dot(normals.normal[ju], n).abs() >= GROUP_COS {
                    seen[ju] = true;
                    members.push(j);
                }
            });
        }
        if members.len() >= MIN_GROUP_VOXELS {
            members.sort_unstable();
            out.push(members);
        }
    }
    out.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
    out
}

/// The cylinder two oriented samples imply, if their normals are not parallel
/// and the two radii agree within the tolerance.
fn from_pair(p1: Vec3, n1: Vec3, p2: Vec3, n2: Vec3, tolerance: f64) -> Option<Cylinder> {
    let axis = cross(n1, n2);
    if dot(axis, axis).sqrt() < MIN_PAIR_SIN {
        return None;
    }
    let axis = unit(axis)?;
    // Closest approach of p1 + t n1 and p2 + s n2. Both normals are
    // perpendicular to the axis, so this is their crossing seen along it.
    let w = sub(p1, p2);
    let b = dot(n1, n2);
    let (d, e) = (dot(n1, w), dot(n2, w));
    let denominator = 1. - b * b;
    let t = (b * e - d) / denominator;
    let s = (e - b * d) / denominator;
    if (t.abs() - s.abs()).abs() > 2. * tolerance {
        return None;
    }
    let point = std::array::from_fn(|k| (p1[k] + t * n1[k] + p2[k] + s * n2[k]) / 2.);
    Some(Cylinder { point, axis, radius: (t.abs() + s.abs()) / 2. })
}

/// Best candidate over `c.draws` seeded pairs, scored on an evenly strided
/// subsample; with the share of that subsample it fits. None when no pair
/// defined a candidate in range.
fn ransac(
    members: &[u32],
    voxels: &VoxelSet,
    normals: &Normals,
    c: &CylinderParams,
    min_radius: f64,
    tolerance: f64,
) -> Option<(Cylinder, f64)> {
    let mut rng = Rng(0x6870 ^ u64::from(members[0]));
    let stride = members.len().div_ceil(c.sample);
    let sample: Vec<u32> = members.iter().copied().step_by(stride).collect();
    let mut best: Option<(Cylinder, usize)> = None;
    for _ in 0..c.draws {
        let (i, j) = (members[rng.below(members.len())] as usize, members[rng.below(members.len())] as usize);
        let Some(candidate) = from_pair(voxels.means[i], normals.normal[i], voxels.means[j], normals.normal[j], tolerance) else {
            continue;
        };
        if candidate.radius < min_radius || candidate.radius > c.max_radius {
            continue;
        }
        let score = sample.iter().filter(|&&k| candidate.fits(voxels.means[k as usize], Some(normals.normal[k as usize]), tolerance)).count();
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((candidate, score));
        }
    }
    best.map(|(cylinder, score)| (cylinder, score as f64 / sample.len() as f64))
}

/// Cylinders among the non-planar voxels, longest first; and whether the
/// group budget cut the search short.
pub(crate) fn detect(
    voxels: &VoxelSet,
    normals: &Normals,
    planar: &[bool],
    params: &Params,
    stats: &mut ScanSegmentationStats,
) -> (Vec<ScanCylinder>, bool) {
    let Some(c) = &params.cylinders else { return (Vec::new(), false) };
    let tolerance = params.distance;
    // Below two voxels a circumference has too few voxels to carry its curvature.
    let min_radius = c.min_radius.unwrap_or(2. * voxels.size);
    let mut groups = groups(voxels, normals, planar);
    let limit_hit = groups.len() > c.max_groups;
    groups.truncate(c.max_groups);
    stats.cylinder_groups = groups.len() as u64;
    let normal_of = |i: u32| normals.valid(i).then(|| normals.normal[i as usize]);
    let mut found = Vec::new();
    for mut members in groups {
        for _ in 0..MAX_PER_GROUP {
            if members.len() < MIN_GROUP_VOXELS {
                break;
            }
            let Some((candidate, _)) = ransac(&members, voxels, normals, c, min_radius, tolerance) else {
                stats.cylinder_candidates_below_share += 1;
                break;
            };
            let Some((cylinder, inliers)) = refine(candidate, &members, &voxels.means, &normal_of, tolerance) else {
                stats.cylinder_refits_failed += 1;
                break;
            };
            // The share is judged on the least-squares refit: the best raw
            // draw of a noisy pipe can sit a centimetre off and fit too few.
            if (inliers.len() as f64) < c.min_fraction * members.len() as f64 {
                stats.cylinder_candidates_below_share += 1;
                break;
            }
            members.retain(|i| inliers.binary_search(i).is_err());
            if cylinder.radius < min_radius || cylinder.radius > c.max_radius {
                stats.cylinders_rejected_for_radius += 1;
                continue;
            }
            let points: Vec<Vec3> = inliers.iter().map(|&i| voxels.means[i as usize]).collect();
            let squares: f64 = points.iter().map(|&p| (cylinder.radial(p).0 - cylinder.radius).powi(2)).sum();
            let rms = (squares / points.len() as f64).sqrt();
            if sphere_rms(&points).is_some_and(|sphere| sphere <= rms) {
                stats.cylinders_rejected_as_spheres += 1;
                continue;
            }
            let arc = arc_degrees(&cylinder, points.iter().copied());
            if arc < c.min_arc {
                stats.cylinders_rejected_for_arc += 1;
                continue;
            }
            let out = describe(&cylinder, &inliers, voxels, rms, arc, params);
            if out.length < c.min_length {
                stats.cylinders_rejected_for_length += 1;
                continue;
            }
            // A surface has at least one inlier voxel per voxel step along its
            // axis; fewer is a loose fit threaded through scattered voxels.
            if (inliers.len() as f64) < out.length / voxels.size {
                stats.cylinders_rejected_as_sparse += 1;
                continue;
            }
            found.push((out, cylinder));
        }
    }
    let mut found = suppress_duplicates(found, stats);
    found.sort_by(|a, b| {
        b.length.total_cmp(&a.length).then_with(|| {
            a.axis_start.iter().zip(&b.axis_start).fold(std::cmp::Ordering::Equal, |o, (x, y)| o.then(x.total_cmp(y)))
        })
    });
    (found, limit_hit)
}

fn duplicates(a: &(ScanCylinder, Cylinder), b: &(ScanCylinder, Cylinder)) -> bool {
    let (x, y) = (&a.1, &b.1);
    let parallel = dot(cross(x.axis, y.axis), cross(x.axis, y.axis)).sqrt() <= DUPLICATE_SIN;
    let (ra, rb) = (x.radius.max(y.radius), x.radius.min(y.radius));
    let coaxial = x.radial(y.point).0.max(y.radial(x.point).0) <= ra / 2.;
    // Extents along a's axis overlap.
    let along = |p: Vec3| dot(sub(p, a.0.axis_start), a.0.axis_direction);
    let (b0, b1) = (along(b.0.axis_start), along(b.0.axis_end));
    let overlap = b0.max(b1) >= 0. && b0.min(b1) <= a.0.length;
    parallel && coaxial && ra <= DUPLICATE_RADIUS_RATIO * rb && overlap
}

/// Keep the best supported of each set of near-identical cylinders (one
/// surface split across groups or tries).
fn suppress_duplicates(mut found: Vec<(ScanCylinder, Cylinder)>, stats: &mut ScanSegmentationStats) -> Vec<ScanCylinder> {
    found.sort_by(|a, b| b.0.inlier_voxels.cmp(&a.0.inlier_voxels).then(a.0.axis_start[0].total_cmp(&b.0.axis_start[0])));
    let mut kept: Vec<(ScanCylinder, Cylinder)> = Vec::new();
    for candidate in found {
        if kept.iter().any(|k| duplicates(k, &candidate)) {
            stats.cylinders_rejected_as_duplicates += 1;
        } else {
            kept.push(candidate);
        }
    }
    kept.into_iter().map(|(out, _)| out).collect()
}

fn describe(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet, rms: f64, arc: f64, params: &Params) -> ScanCylinder {
    let along_up = dot(cylinder.axis, params.up);
    let orientation = if along_up.abs() >= params.cos_class {
        AxisOrientation::Vertical
    } else if along_up.abs() <= params.sin_class {
        AxisOrientation::Horizontal
    } else {
        AxisOrientation::Sloped
    };
    let axis = match orientation {
        AxisOrientation::Horizontal => canonical_sign(cylinder.axis),
        _ if along_up < 0. => cylinder.axis.map(|v| -v),
        _ => cylinder.axis,
    };
    let (mut lo, mut hi, mut points) = (f64::INFINITY, f64::NEG_INFINITY, 0_u64);
    for &i in inliers {
        let t = dot(sub(voxels.means[i as usize], cylinder.point), axis);
        lo = lo.min(t);
        hi = hi.max(t);
        points += u64::from(voxels.counts[i as usize]);
    }
    let at = |t: f64| -> Vec3 { std::array::from_fn(|k| cylinder.point[k] + t * axis[k] + params.origin[k]) };
    let (start, end) = (at(lo), at(hi));
    let (h0, h1) = (dot(start, params.up), dot(end, params.up));
    ScanCylinder {
        axis_start: start,
        axis_end: end,
        axis_direction: axis,
        radius: cylinder.radius,
        length: hi - lo,
        height_range: [h0.min(h1), h0.max(h1)],
        arc_degrees: arc,
        inlier_points: points,
        inlier_voxels: inliers.len() as u32,
        rms_metres: rms,
        orientation,
    }
}
