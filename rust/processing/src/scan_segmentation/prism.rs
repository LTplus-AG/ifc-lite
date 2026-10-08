// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Faceted (prism) columns: a ring of flat faces that is a regular polygon
//! of six or more sides (#6893).
//!
//! A ring that did not pass as a round column is a faceted column when:
//! - it has at least `MIN_SEEN_FACES` faces, and consecutive faces (by normal
//!   angle; the widest step is the unseen side) turn by one step of a regular
//!   polygon, each within `STEP_TOLERANCE` of it, through at least
//!   `MIN_TOTAL_TURN` in all (a 135 degree bay window of three faces turns
//!   90). Ring links turn by at most 65 degrees, so the polygon has six or
//!   more sides;
//! - every face lies at one distance (the apothem) from a common axis, within
//!   the distance tolerance (a least-squares fit of the axis and apothem to
//!   the face lines). Equal turns about one apothem make equal sides, so the
//!   faces are alike without a width test (a face that runs on as a wall has
//!   its middle off the ring's perpendiculars and never joins it);
//! - its circumradius is in the cylinder radius range and its height at least
//!   the minimum length.
//!
//! A rectangular column (four faces turning 90 degrees) stays four planes;
//! see `ring::MAX_TURN`.
use super::cylinder::{describe, Found};
use super::cylinder_fit::{arc_degrees, Cylinder};
use super::grow::Region;
use super::normals::{unit, Vec3};
use super::options::Params;
use super::report::ScanFacets;
use super::ring::{dot2, Plan, Ring, P2};
use super::voxel::VoxelSet;
use nalgebra::{Matrix3, Vector3};
use std::f64::consts::{PI, TAU};

const MIN_SEEN_FACES: usize = 3;
const MIN_TOTAL_TURN: f64 = 2.094; // 120 degrees
/// Share of the polygon's step each turn may be off (never under 2 degrees).
const STEP_TOLERANCE: f64 = 0.15;
const MIN_STEP_TOLERANCE: f64 = 0.0349; // 2 degrees

fn angle(n: P2) -> f64 {
    n[1].atan2(n[0])
}

/// The steps between consecutive faces (by angle), the widest removed (the
/// side not seen; for a closed ring, one of the steps).
fn steps(ring: &Ring) -> Vec<f64> {
    let k = ring.faces.len();
    let all: Vec<f64> = (0..k).map(|i| (angle(ring.faces[(i + 1) % k].normal) - angle(ring.faces[i].normal)).rem_euclid(TAU)).collect();
    let widest = (0..k).max_by(|&a, &b| all[a].total_cmp(&all[b]).then(b.cmp(&a))).unwrap_or(0);
    (1..k).map(|j| all[(widest + j) % k]).collect()
}

/// Least-squares axis (plan) and apothem: n . c + a = n . mid per face.
fn axis_and_apothem(ring: &Ring) -> Option<(P2, f64)> {
    let (mut m, mut b) = (Matrix3::zeros(), Vector3::zeros());
    for f in &ring.faces {
        let row = Vector3::new(f.normal[0], f.normal[1], 1.);
        m += row * row.transpose();
        b += row * dot2(f.normal, f.mid);
    }
    let s = m.lu().solve(&b)?;
    (s[2] > 0.).then_some(([s[0], s[1]], s[2]))
}

/// The faceted column `ring` is, if it is one; its faces' voxels are the
/// inliers.
pub(crate) fn prism(ring: &Ring, regions: &[Region], voxels: &VoxelSet, params: &Params, plan: &Plan) -> Option<Found> {
    let c = params.cylinders.as_ref()?;
    let k = ring.faces.len();
    if k < MIN_SEEN_FACES {
        return None;
    }
    let seen = steps(ring);
    let mut sorted = seen.clone();
    sorted.sort_by(f64::total_cmp);
    let n = (TAU / sorted[sorted.len() / 2]).round() as usize;
    let step = TAU / n as f64;
    let tolerance = (STEP_TOLERANCE * step).max(MIN_STEP_TOLERANCE);
    if seen.iter().any(|s| (s - step).abs() > tolerance) || (k - 1) as f64 * step < MIN_TOTAL_TURN - tolerance {
        return None;
    }
    let (centre, apothem) = axis_and_apothem(ring)?;
    if ring.faces.iter().any(|f| (dot2([f.mid[0] - centre[0], f.mid[1] - centre[1]], f.normal) - apothem).abs() > params.distance) {
        return None;
    }
    let radius = apothem / (PI / n as f64).cos();
    if radius < c.min_radius.unwrap_or(2. * voxels.size) || radius > c.max_radius {
        return None;
    }
    let mut inliers: Vec<u32> = ring.faces.iter().flat_map(|f| regions[f.plane].voxels.iter().copied()).collect();
    inliers.sort_unstable();
    inliers.dedup();
    let cylinder = Cylinder { point: plan.lift(centre, 0.), axis: plan.up, radius };
    let points: Vec<Vec3> = inliers.iter().map(|&i| voxels.means[i as usize]).collect();
    let mut squares = 0.;
    for f in &ring.faces {
        for &i in &regions[f.plane].voxels {
            let q = plan.project(voxels.means[i as usize]);
            squares += (dot2([q[0] - centre[0], q[1] - centre[1]], f.normal) - apothem).powi(2);
        }
    }
    let rms = (squares / ring.faces.iter().map(|f| regions[f.plane].voxels.len()).sum::<usize>() as f64).sqrt();
    let mut out = describe(&cylinder, &inliers, voxels, rms, arc_degrees(&cylinder, points.into_iter()), params);
    if out.length < c.min_length {
        return None;
    }
    out.faceted = Some(ScanFacets { faces: n as u32, face_normal: face_normal(ring, n, plan), apothem });
    Some(Found { out, cylinder, inliers })
}

/// The outward normal of the face nearest the frame's +x (projected across
/// the axis; +y when the axis runs along x): of the polygon's `n` face
/// directions, fitted to all seen faces (circular mean of n x angle).
fn face_normal(ring: &Ring, n: usize, plan: &Plan) -> Vec3 {
    let (s, c) = ring.faces.iter().fold((0., 0.), |(s, c), f| {
        let a = n as f64 * angle(f.normal);
        (s + a.sin(), c + a.cos())
    });
    let phase = s.atan2(c) / n as f64;
    let step = TAU / n as f64;
    let reference = if plan.up[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
    let r = plan.project(reference);
    let k = ((angle(r) - phase) / step).round();
    let a = phase + k * step;
    let direction: Vec3 = std::array::from_fn(|i| a.cos() * plan.e1[i] + a.sin() * plan.e2[i]);
    unit(direction).unwrap_or(direction)
}

#[cfg(test)]
#[path = "prism_tests.rs"]
mod tests;
