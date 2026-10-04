// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane fits over voxel means: an anchored moment accumulator, and the
//! per-voxel normal and curvature from the neighbourhood of voxel means.
//!
//! Voxel means are weighted equally, not by point count, so a densely scanned
//! patch next to the scanner does not pull a fit away from sparser surface.
use super::voxel::VoxelSet;
use crate::point_pca::symmetric_eigen_ascending;
use nalgebra::Matrix3;

pub(crate) type Vec3 = [f64; 3];

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub(crate) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub(crate) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub(crate) fn unit(a: Vec3) -> Option<Vec3> {
    let length = dot(a, a).sqrt();
    (length.is_finite() && length > 1e-12).then(|| a.map(|v| v / length))
}

/// First and second moments relative to a fixed anchor, so a single pass over
/// coordinates far from zero keeps its precision.
#[derive(Clone)]
pub(crate) struct Moments {
    anchor: Vec3,
    n: f64,
    s: Vec3,
    ss: [[f64; 3]; 3],
}

/// Least-squares plane: unit normal, centroid, ascending scatter eigenvalues.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Fit {
    pub normal: Vec3,
    pub centroid: Vec3,
    pub values: Vec3,
}

impl Moments {
    pub fn new(anchor: Vec3) -> Self {
        Self { anchor, n: 0., s: [0.; 3], ss: [[0.; 3]; 3] }
    }
    pub fn add(&mut self, p: Vec3) {
        let d = sub(p, self.anchor);
        self.n += 1.;
        for i in 0..3 {
            self.s[i] += d[i];
            for j in 0..3 {
                self.ss[i][j] += d[i] * d[j];
            }
        }
    }
    pub fn count(&self) -> f64 {
        self.n
    }
    /// None when empty, or when the support is collinear (no unique normal).
    pub fn fit(&self) -> Option<Fit> {
        if self.n < 3. {
            return None;
        }
        let mean = self.s.map(|v| v / self.n);
        let covariance = Matrix3::from_fn(|i, j| self.ss[i][j] / self.n - mean[i] * mean[j]);
        let eigen = symmetric_eigen_ascending(covariance);
        let values = eigen.values.map(|v| v.max(0.));
        if !(values[2] > 0.) || values[1] <= 1e-3 * values[2] {
            return None;
        }
        let normal = unit(eigen.vectors[0])?;
        let centroid = std::array::from_fn(|a| self.anchor[a] + mean[a]);
        Some(Fit { normal, centroid, values })
    }
}

/// Flip so the largest-magnitude component is positive (first axis on ties):
/// a deterministic sign for an unsigned direction.
pub(crate) fn canonical_sign(n: Vec3) -> Vec3 {
    let mut axis = 0;
    for a in 1..3 {
        if n[a].abs() > n[axis].abs() {
            axis = a;
        }
    }
    if n[axis] < 0. { n.map(|v| -v) } else { n }
}

/// Per-voxel unsigned normal and curvature (smallest eigenvalue over the
/// eigenvalue sum); curvature is infinite where there is no normal.
pub(crate) struct Normals {
    pub normal: Vec<Vec3>,
    pub curvature: Vec<f64>,
}

impl Normals {
    pub fn valid(&self, i: u32) -> bool {
        self.curvature[i as usize].is_finite()
    }
}

pub(crate) fn estimate(voxels: &VoxelSet, rings: i32, min_support: usize) -> Normals {
    let n = voxels.len();
    let mut normal = vec![[0.; 3]; n];
    let mut curvature = vec![f64::INFINITY; n];
    for i in 0..n {
        let mut moments = Moments::new(voxels.means[i]);
        moments.add(voxels.means[i]);
        voxels.for_each_neighbor(i as u32, rings, |j| moments.add(voxels.means[j as usize]));
        if (moments.count() as usize) < min_support {
            continue;
        }
        let Some(fit) = moments.fit() else { continue };
        let total: f64 = fit.values.iter().sum();
        normal[i] = canonical_sign(fit.normal);
        curvature[i] = fit.values[0] / total;
    }
    Normals { normal, curvature }
}
