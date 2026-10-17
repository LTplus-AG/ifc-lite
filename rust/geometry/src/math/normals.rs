// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one normal-transform policy (GEOM-11, D23, #7772). Geometry-only: it
//! speaks nalgebra, so it is `pub(crate)`.
//!
//! Normals transform by the inverse-transpose of the 4x4, not the raw linear
//! block: under a non-uniform `IfcCartesianTransformationOperator3DnonUniform`
//! scale the raw block skews a normal off the true surface normal. A singular
//! transform has no inverse, and a normal that comes out zero or non-finite has
//! no direction; both write a **zero vector**, never NaN and never an
//! `M`-skewed vector. A regular transform is unchanged: the same 4x4
//! inverse-transpose and the same divide by the norm.

use nalgebra::{Matrix4, Vector3};

/// `(M⁻¹)ᵀ`, or `None` when `M` is singular.
#[inline]
pub(crate) fn normal_matrix(m: &Matrix4<f64>) -> Option<Matrix4<f64>> {
    m.try_inverse().map(|inverse| inverse.transpose())
}

/// Transform a flat `[nx, ny, nz, ...]` normal buffer in place (complete
/// triplets only), renormalising each. See the module doc for the
/// degenerate policy.
pub(crate) fn transform_normals_in_place(normals: &mut [f32], m: &Matrix4<f64>) {
    let matrix = normal_matrix(m);
    for chunk in normals.chunks_exact_mut(3) {
        let out = matrix
            .as_ref()
            .and_then(|nm| {
                let normal = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = (nm * normal.to_homogeneous()).xyz();
                let len = t.norm();
                (len.is_finite() && len > 0.0).then(|| t.unscale(len))
            })
            .unwrap_or_else(Vector3::zeros);
        chunk[0] = out.x as f32;
        chunk[1] = out.y as f32;
        chunk[2] = out.z as f32;
    }
}
