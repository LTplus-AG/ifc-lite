// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Triangle shape as the mesh census reads it.
//!
//! One measure for the repo: a triangle's longest edge over its altitude onto
//! that edge. It is what `mesh_census` reports and what
//! `scripts/mesh-census-compare.mjs` judges a geometry change by, so code that
//! decides between two triangulations asks the same question here.

use crate::mesh::Mesh;

/// Longest edge over altitude above which a triangle is a sliver: the bar of
/// `mesh_census`.
const SLIVER_ASPECT: f64 = 50.0;

/// The census's shape reading of a mesh.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriangleShape {
    /// Triangles past [`SLIVER_ASPECT`].
    pub slivers: usize,
    /// The worst aspect of any triangle with area; 0 for a mesh without one.
    pub max_aspect: f64,
}

/// Read `mesh` as the census does. Triangles without area and triangles naming
/// a vertex the mesh does not have are left out, as there.
pub fn triangle_shape(mesh: &Mesh) -> TriangleShape {
    let point = |i: u32| -> Option<[f64; 3]> {
        let start = (i as usize).checked_mul(3)?;
        let p = mesh.positions.get(start..start.checked_add(3)?)?;
        Some([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
    };
    let mut shape = TriangleShape { slivers: 0, max_aspect: 0.0 };
    for t in mesh.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (point(t[0]), point(t[1]), point(t[2])) else {
            continue;
        };
        let sub = |p: [f64; 3], q: [f64; 3]| [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        let dot = |p: [f64; 3], q: [f64; 3]| p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
        let (u, v, w) = (sub(b, a), sub(c, a), sub(c, b));
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let twice_area = dot(n, n).sqrt();
        if twice_area <= 0.0 {
            continue;
        }
        // Longest edge squared over twice the area: the edge over its altitude.
        let aspect = dot(u, u).max(dot(v, v)).max(dot(w, w)) / twice_area;
        shape.max_aspect = shape.max_aspect.max(aspect);
        shape.slivers += usize::from(aspect > SLIVER_ASPECT);
    }
    shape
}
