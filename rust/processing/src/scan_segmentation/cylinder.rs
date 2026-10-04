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
//!    minimum length, when their normals do not turn around the axis as a
//!    cylinder's do (flat facets meeting at an angle), or when the median
//!    axial slice shows under half of the claimed arc (clutter in a corner). Its inliers then leave the group, and the next candidate
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
use super::refit::plane_basis;
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
/// Across a cylinder the normal turns as fast as the position around the
/// axis (median ratio 0.7..0.9 measured over real pipes and columns, half and
/// third arcs, 1 cm noise). Across flat facets meeting at an angle it barely
/// turns (0.14..0.44 measured for 90 and 120 degree strip pairs and a
/// chamfered corner): within 2 cm a facet 8 cm from an axis matches a radius
/// over about +-35 degrees, so two facets otherwise pass for a pipe.
const MIN_TURNING_RATIO: f64 = 0.6;
/// Every axial slice (3 voxels thick) of a real cylinder shows most of the
/// arc the whole cylinder covers: 0.70..1.00 of the occupied 10 degree bins
/// at the median slice, measured over pipes and columns (half, third and
/// wall-flush arcs, 1 cm noise). Clutter in a wall corner or a wedge of
/// sheets shows different fragments at different heights (0.36 and 0.10 on
/// the two false cylinders of a real apartment scan).
const MIN_SLICE_ARC_SHARE: f64 = 0.5;
const SLICE_VOXELS: f64 = 3.;
const ARC_BINS_10_DEGREES: usize = 36;
/// Neighbour pairs closer than this around the axis are not used to judge
/// turning: their angle difference is mostly noise.
const MIN_PAIR_TURN: f64 = 0.052; // 3 degrees

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
            if turning_ratio(&cylinder, &inliers, voxels, &normal_of).is_none_or(|ratio| ratio < MIN_TURNING_RATIO) {
                stats.cylinders_rejected_as_facets += 1;
                continue;
            }
            if slice_arc_share(&cylinder, &inliers, voxels) < MIN_SLICE_ARC_SHARE {
                stats.cylinders_rejected_for_uneven_arc += 1;
                continue;
            }
            let out = describe(&cylinder, &inliers, voxels, rms, arc, params);
            if out.length < c.min_length {
                stats.cylinders_rejected_for_length += 1;
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

/// Occupied 10 degree bins at the median axial slice, over the bins the whole
/// cylinder occupies: about 1 when the same arc is seen at every height.
fn slice_arc_share(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet) -> f64 {
    let (u, _) = plane_basis(cylinder.axis);
    let v = cross(cylinder.axis, u);
    let along = |i: u32| dot(sub(voxels.means[i as usize], cylinder.point), cylinder.axis);
    let (lo, hi) = inliers.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &i| (lo.min(along(i)), hi.max(along(i))));
    let thickness = SLICE_VOXELS * voxels.size;
    // Bounded: inliers span at most the group, so slices <= inliers.
    let count = (((hi - lo) / thickness) as usize + 1).min(inliers.len());
    let mut slices = vec![[false; ARC_BINS_10_DEGREES]; count];
    let mut whole = [false; ARC_BINS_10_DEGREES];
    for &i in inliers {
        let d = sub(voxels.means[i as usize], cylinder.point);
        let angle = dot(d, v).atan2(dot(d, u)).rem_euclid(std::f64::consts::TAU);
        let bin = ((angle / std::f64::consts::TAU * ARC_BINS_10_DEGREES as f64) as usize).min(ARC_BINS_10_DEGREES - 1);
        slices[(((along(i) - lo) / thickness) as usize).min(count - 1)][bin] = true;
        whole[bin] = true;
    }
    let mut occupied: Vec<usize> = slices.iter().map(|s| s.iter().filter(|b| **b).count()).collect();
    let mid = occupied.len() / 2;
    let median = *occupied.select_nth_unstable(mid).1;
    median as f64 / whole.iter().filter(|b| **b).count().max(1) as f64
}

/// Median, over neighbouring inlier pairs at least `MIN_PAIR_TURN` apart
/// around the axis, of how far the normal turns per radian of position: about
/// 1 on a cylinder, about 0 on flat facets. None when no pair qualifies.
fn turning_ratio(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet, normal_of: &dyn Fn(u32) -> Option<Vec3>) -> Option<f64> {
    let (u, _) = plane_basis(cylinder.axis);
    let v = cross(cylinder.axis, u);
    // (position angle, normal angle) about the axis, the normal facing out.
    let angles = |i: u32| -> Option<(f64, f64)> {
        let normal = normal_of(i)?;
        let (_, radial) = cylinder.radial(voxels.means[i as usize]);
        let normal = if dot(normal, radial) < 0. { normal.map(|x| -x) } else { normal };
        Some((dot(radial, v).atan2(dot(radial, u)), dot(normal, v).atan2(dot(normal, u))))
    };
    let wrap = |d: f64| (d + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
    let mut ratios = Vec::new();
    for &i in inliers {
        let Some((pi, ni)) = angles(i) else { continue };
        voxels.for_each_neighbor(i, 1, |j| {
            if j <= i || inliers.binary_search(&j).is_err() {
                return;
            }
            let Some((pj, nj)) = angles(j) else { return };
            let turn = wrap(pj - pi);
            if turn.abs() >= MIN_PAIR_TURN {
                ratios.push(wrap(nj - ni) / turn);
            }
        });
    }
    if ratios.is_empty() {
        return None;
    }
    let mid = ratios.len() / 2;
    Some(*ratios.select_nth_unstable_by(mid, f64::total_cmp).1)
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
