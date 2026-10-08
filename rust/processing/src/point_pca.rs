// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Principal axes of a symmetric 3×3 scatter, shared by the local planes of
//! registered point transfer (`appearance::transfer_points`) and the voxel
//! normals and plane fits of scan segmentation (`scan_segmentation`).

use nalgebra::{Matrix3, SymmetricEigen};

/// Eigenpairs sorted by ascending eigenvalue (a stable sort, so equal values
/// keep nalgebra's order). For a point scatter, `vectors[0]` is the plane
/// normal, `values[0]` the variance along it and `values[1]` the smaller
/// in-plane spread (zero for a collinear support).
pub(crate) struct Eigen3 {
    pub values: [f64; 3],
    pub vectors: [[f64; 3]; 3],
}

pub(crate) fn symmetric_eigen_ascending(scatter: Matrix3<f64>) -> Eigen3 {
    let eigen = SymmetricEigen::new(scatter);
    let values: [f64; 3] = std::array::from_fn(|i| eigen.eigenvalues[i]);
    let mut order = [0_usize, 1, 2];
    order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
    Eigen3 {
        values: order.map(|i| values[i]),
        vectors: order.map(|i| {
            let column = eigen.eigenvectors.column(i);
            [column[0], column[1], column[2]]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascending_pairs_recover_a_known_scatter() {
        // Variances 9, 1, 0.01 along a rotated orthonormal frame.
        let (c, s) = (0.6_f64, 0.8_f64);
        let frame = Matrix3::new(c, -s, 0., s, c, 0., 0., 0., 1.);
        let scatter = frame * Matrix3::from_diagonal(&[9., 0.01, 1.].into()) * frame.transpose();
        let eigen = symmetric_eigen_ascending(scatter);
        for (value, expected) in eigen.values.iter().zip([0.01, 1., 9.]) {
            assert!((value - expected).abs() < 1e-12, "{value} vs {expected}");
        }
        // Smallest variance lies along the frame's second column (-s, c, 0).
        let n = eigen.vectors[0];
        assert!((n[0] * -s + n[1] * c).abs() > 1. - 1e-12, "{n:?}");
        assert!((eigen.vectors[1][2]).abs() > 1. - 1e-12);
    }
}
