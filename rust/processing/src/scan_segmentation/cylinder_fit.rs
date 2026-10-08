// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinder geometry over voxel means and normals: candidates from seeded
//! RANSAC over point+normal pairs; the least-squares refit, with the axis as
//! the direction all normals are perpendicular to and the circle across it
//! (algebraic fit, then a bounded Gauss-Newton refinement of the geometric
//! distance); the competing sphere fit; and the arc the inliers cover.
use super::normals::{cross, dot, sub, unit, Normals, Vec3};
use super::options::CylinderParams;
use super::refit::plane_basis;
use super::voxel::VoxelSet;
use crate::point_pca::symmetric_eigen_ascending;
use nalgebra::{Matrix3, Matrix4, Vector3, Vector4};

/// Gauss-Newton steps for the circle; it converges in a handful.
const CIRCLE_ITERATIONS: usize = 10;
/// Normals must agree with the radial direction within this to count.
pub(crate) const RADIAL_COS: f64 = 0.866; // cos 30 degrees
/// Histogram bins for arc coverage (5 degrees each).
const ARC_BINS: usize = 72;
/// Two normals closer than 30 degrees to parallel (or antiparallel) cross
/// too shallowly for a stable axis and radius: noise of a few degrees moves
/// their crossing by a radius or more.
const MIN_PAIR_SIN: f64 = 0.5; // sin 30 degrees

/// An infinite cylinder: a point on the axis, the unit axis, the radius.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Cylinder {
    pub point: Vec3,
    pub axis: Vec3,
    pub radius: f64,
}

impl Cylinder {
    /// (distance from the axis, unit radial direction) of `p`.
    pub fn radial(&self, p: Vec3) -> (f64, Vec3) {
        let d = sub(p, self.point);
        let along = dot(d, self.axis);
        let r: Vec3 = std::array::from_fn(|k| d[k] - along * self.axis[k]);
        let distance = dot(r, r).sqrt();
        (distance, if distance > 0. { r.map(|v| v / distance) } else { [0.; 3] })
    }

    /// Within `tolerance` of the surface and, when a normal is known, with the
    /// normal along the radial direction.
    pub fn fits(&self, p: Vec3, normal: Option<Vec3>, tolerance: f64) -> bool {
        let (distance, radial) = self.radial(p);
        (distance - self.radius).abs() <= tolerance && normal.is_none_or(|n| dot(n, radial).abs() >= RADIAL_COS)
    }
}

/// The axis direction every normal is perpendicular to: the eigenvector of
/// the smallest eigenvalue of the normals' scatter. None when the normals do
/// not span a fan (all parallel: a plane strip, not a cylinder).
pub(crate) fn axis_from_normals(normals: impl Iterator<Item = Vec3>) -> Option<Vec3> {
    let mut scatter = Matrix3::zeros();
    let mut n = 0.;
    for v in normals {
        let v = Vector3::from(v);
        scatter += v * v.transpose();
        n += 1.;
    }
    if n < 3. {
        return None;
    }
    let eigen = symmetric_eigen_ascending(scatter / n);
    (eigen.values[1] > 1e-4).then(|| unit(eigen.vectors[0])).flatten()
}

/// Circle through 2D points: algebraic (Kasa) start, then Gauss-Newton on the
/// geometric residual. Returns (centre, radius).
pub(crate) fn fit_circle(points: &[[f64; 2]]) -> Option<([f64; 2], f64)> {
    let n = points.len() as f64;
    if n < 3. {
        return None;
    }
    let mean = points.iter().fold([0.; 2], |m, p| [m[0] + p[0] / n, m[1] + p[1] / n]);
    let (mut a, mut b) = (Matrix3::zeros(), Vector3::zeros());
    for p in points {
        let (x, y) = (p[0] - mean[0], p[1] - mean[1]);
        let row = Vector3::new(x, y, 1.);
        a += row * row.transpose();
        b += row * (x * x + y * y);
    }
    let solution = a.lu().solve(&b)?;
    let (mut cx, mut cy) = (solution[0] / 2., solution[1] / 2.);
    let mut r = (solution[2] + cx * cx + cy * cy).max(0.).sqrt();
    for _ in 0..CIRCLE_ITERATIONS {
        let (mut jtj, mut jtr) = (Matrix3::zeros(), Vector3::zeros());
        for p in points {
            let (dx, dy) = (p[0] - mean[0] - cx, p[1] - mean[1] - cy);
            let d = dx.hypot(dy);
            if d == 0. {
                continue;
            }
            let j = Vector3::new(-dx / d, -dy / d, -1.);
            jtj += j * j.transpose();
            jtr += j * (d - r);
        }
        let Some(step) = jtj.lu().solve(&(-jtr)) else { break };
        cx += step[0];
        cy += step[1];
        r += step[2];
        if step.norm() < 1e-10 {
            break;
        }
    }
    (r.is_finite() && r > 0.).then_some(([cx + mean[0], cy + mean[1]], r))
}

/// Refit `start` on its inliers among `members`: axis from their normals,
/// circle across the axis. Two fixed passes (inliers are re-selected with the
/// refined cylinder). Returns the cylinder and its final inliers.
pub(crate) fn refine(
    start: Cylinder,
    members: &[u32],
    means: &[Vec3],
    normal_of: &dyn Fn(u32) -> Option<Vec3>,
    tolerance: f64,
) -> Option<(Cylinder, Vec<u32>)> {
    let mut current = start;
    for _ in 0..2 {
        let inliers: Vec<u32> = members.iter().copied().filter(|&i| current.fits(means[i as usize], normal_of(i), tolerance)).collect();
        if inliers.len() < 6 {
            return None;
        }
        let axis = axis_from_normals(inliers.iter().filter_map(|&i| normal_of(i))).unwrap_or(current.axis);
        let (u, v) = plane_basis(axis);
        let projected: Vec<[f64; 2]> = inliers
            .iter()
            .map(|&i| {
                let d = sub(means[i as usize], current.point);
                [dot(d, u), dot(d, v)]
            })
            .collect();
        let (centre, radius) = fit_circle(&projected)?;
        let point = std::array::from_fn(|k| current.point[k] + centre[0] * u[k] + centre[1] * v[k]);
        current = Cylinder { point, axis, radius };
    }
    let inliers: Vec<u32> = members.iter().copied().filter(|&i| current.fits(means[i as usize], normal_of(i), tolerance)).collect();
    (inliers.len() >= 6).then_some((current, inliers))
}

/// RMS geometric residual of the best sphere through `points` (algebraic
/// fit), or None when degenerate.
pub(crate) fn sphere_rms(points: &[Vec3]) -> Option<f64> {
    let n = points.len() as f64;
    if n < 4. {
        return None;
    }
    let mean = points.iter().fold([0.; 3], |m, p| std::array::from_fn(|k| m[k] + p[k] / n));
    let (mut a, mut b) = (Matrix4::zeros(), Vector4::zeros());
    for p in points {
        let d = sub(*p, mean);
        let row = Vector4::new(d[0], d[1], d[2], 1.);
        a += row * row.transpose();
        b += row * dot(d, d);
    }
    let s = a.lu().solve(&b)?;
    let centre = [s[0] / 2., s[1] / 2., s[2] / 2.];
    let radius = (s[3] + dot(centre, centre)).max(0.).sqrt();
    let squares: f64 = points.iter().map(|p| (dot(sub(sub(*p, mean), centre), sub(sub(*p, mean), centre)).sqrt() - radius).powi(2)).sum();
    Some((squares / n).sqrt())
}

/// Degrees of the circumference covered: 360 minus the widest empty gap
/// between occupied 5 degree bins.
pub(crate) fn arc_degrees(cylinder: &Cylinder, points: impl Iterator<Item = Vec3>) -> f64 {
    let (u, _) = plane_basis(cylinder.axis);
    let v = cross(cylinder.axis, u);
    let mut bins = [false; ARC_BINS];
    for p in points {
        let d = sub(p, cylinder.point);
        let angle = dot(d, v).atan2(dot(d, u)).rem_euclid(std::f64::consts::TAU);
        bins[((angle / std::f64::consts::TAU * ARC_BINS as f64) as usize).min(ARC_BINS - 1)] = true;
    }
    let Some(first) = bins.iter().position(|&b| b) else { return 0. };
    let (mut widest, mut run) = (0, 0);
    for k in 1..=ARC_BINS {
        if bins[(first + k) % ARC_BINS] {
            widest = widest.max(run);
            run = 0;
        } else {
            run += 1;
        }
    }
    360. * (ARC_BINS - widest) as f64 / ARC_BINS as f64
}

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
pub(crate) fn ransac(
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

#[cfg(test)]
#[path = "cylinder_fit_tests.rs"]
mod tests;
