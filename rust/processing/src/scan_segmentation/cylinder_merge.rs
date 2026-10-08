// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One surface, one cylinder: near-identical cylinders (one surface found
//! twice, across groups, tries, or as both a round and a faceted fit) are
//! reduced to the best supported one, and coaxial pieces of one radius with a
//! band of missing points between them are joined.
use super::cylinder::Found;
use super::cylinder_fit::Cylinder;
use super::normals::{cross, dot, sub, Vec3};
use super::report::{ScanCylinder, ScanSegmentationStats};

/// Near-identical cylinders (same axis line within this angle, axis lines
/// within half the larger radius, radii within 25 %, overlapping
/// extents) are one surface found twice; only the best supported is kept.
const DUPLICATE_RADIUS_RATIO: f64 = 1.25;
const DUPLICATE_SIN: f64 = 0.087; // sin 5 degrees

/// How two cylinders on one axis line (parallel within 5 degrees, axis lines
/// within half the larger radius) relate: the same surface found twice
/// (overlapping extents, radii within 25 %: refits of one noisy or
/// out-of-round surface), or one column whose points have a band of missing
/// density (a gap up to `max_gap` along the axis, radii within
/// `radius_tolerance`, one voxel: a column on a wider plinth stays two).
enum Relation {
    Unrelated,
    Duplicate,
    Continuation,
}

/// Axes parallel within 5 degrees, axis lines within half the larger radius.
pub(crate) fn coaxial(x: &Cylinder, y: &Cylinder) -> bool {
    let parallel = dot(cross(x.axis, y.axis), cross(x.axis, y.axis)).sqrt() <= DUPLICATE_SIN;
    parallel && x.radial(y.point).0.max(y.radial(x.point).0) <= x.radius.max(y.radius) / 2.
}

/// Radii within 25 % of each other.
pub(crate) fn similar_radius(x: &Cylinder, y: &Cylinder) -> bool {
    x.radius.max(y.radius) <= DUPLICATE_RADIUS_RATIO * x.radius.min(y.radius)
}

fn relation(a: &Found, b: &Found, max_gap: f64, radius_tolerance: f64) -> Relation {
    let (x, y) = (&a.cylinder, &b.cylinder);
    if !coaxial(x, y) {
        return Relation::Unrelated;
    }
    let along = |p: Vec3| dot(sub(p, a.out.axis_start), a.out.axis_direction);
    let (b0, b1) = (along(b.out.axis_start), along(b.out.axis_end));
    let gap = (b0.min(b1) - a.out.length).max(-b0.max(b1));
    if gap <= 0. && similar_radius(x, y) {
        Relation::Duplicate
    } else if gap > 0. && gap <= max_gap && (x.radius - y.radius).abs() <= radius_tolerance {
        Relation::Continuation
    } else {
        Relation::Unrelated
    }
}

/// Extend `a` over `b`'s extent along `a`'s axis and pool their support.
fn absorb(a: &mut ScanCylinder, b: &ScanCylinder, up: Vec3) {
    let dir = a.axis_direction;
    let along = |p: Vec3| dot(sub(p, a.axis_start), dir);
    let (lo, hi) = [0., a.length, along(b.axis_start), along(b.axis_end)]
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &t| (lo.min(t), hi.max(t)));
    let start = a.axis_start;
    let at = |t: f64| -> Vec3 { std::array::from_fn(|k| start[k] + t * dir[k]) };
    (a.axis_start, a.axis_end, a.length) = (at(lo), at(hi), hi - lo);
    let (h0, h1) = (dot(a.axis_start, up), dot(a.axis_end, up));
    a.height_range = [h0.min(h1), h0.max(h1)];
    let (na, nb) = (f64::from(a.inlier_voxels), f64::from(b.inlier_voxels));
    a.rms_metres = ((a.rms_metres.powi(2) * na + b.rms_metres.powi(2) * nb) / (na + nb)).sqrt();
    a.arc_degrees = a.arc_degrees.max(b.arc_degrees);
    a.inlier_points += b.inlier_points;
    a.inlier_voxels += b.inlier_voxels;
}

/// Keep the best supported of each set of near-identical cylinders (one
/// surface split across groups or tries), and join coaxial pieces separated
/// by a short band without points. Repeats until nothing changes, so a chain
/// of pieces joins regardless of order (bounded: each pass removes one).
pub(crate) fn suppress_duplicates(
    mut found: Vec<Found>,
    max_gap: f64,
    radius_tolerance: f64,
    up: Vec3,
    stats: &mut ScanSegmentationStats,
) -> Vec<Found> {
    found.sort_by(|a, b| b.out.inlier_voxels.cmp(&a.out.inlier_voxels).then(a.out.axis_start[0].total_cmp(&b.out.axis_start[0])));
    'pass: loop {
        for i in 0..found.len() {
            for j in i + 1..found.len() {
                match relation(&found[i], &found[j], max_gap, radius_tolerance) {
                    Relation::Unrelated => continue,
                    Relation::Duplicate => stats.cylinders_rejected_as_duplicates += 1,
                    Relation::Continuation => {
                        let b = found[j].out.clone();
                        absorb(&mut found[i].out, &b, up);
                        let more = std::mem::take(&mut found[j].inliers);
                        found[i].inliers.extend(more);
                        found[i].inliers.sort_unstable();
                        found[i].inliers.dedup();
                        stats.cylinders_joined_across_gaps += 1;
                    }
                }
                found.remove(j);
                continue 'pass;
            }
        }
        break;
    }
    found
}
