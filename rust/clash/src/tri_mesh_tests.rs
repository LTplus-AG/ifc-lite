// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins #5220: a NaN vertex must NaN a triangle's own bounds (matching the TS
//! `triBounds`'s `Math.min`/`Math.max`), not fabricate finite bounds from the
//! other two vertices the way `f64::min`/`f64::max` would.

use super::TriMesh;
use crate::aabb::Aabb;

/// A single triangle whose first vertex is entirely NaN (all three coords).
fn nan_triangle_mesh() -> TriMesh {
    #[rustfmt::skip]
    let positions = vec![
        f64::NAN, f64::NAN, f64::NAN,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    ];
    let indices = vec![0u32, 1, 2];
    TriMesh::new(positions, indices)
}

#[test]
fn nan_vertex_makes_tri_bounds_non_finite() {
    let mesh = nan_triangle_mesh();
    let bounds = mesh.tri_bounds(0);
    // Every component must be NaN, not merely one axis: a finite component
    // fabricated from the two clean vertices is exactly the `f64::min`/
    // `f64::max`-dropped-NaN regression this pins.
    for axis in 0..3 {
        assert!(bounds.min[axis].is_nan(), "min[{axis}] should be NaN, got {}", bounds.min[axis]);
        assert!(bounds.max[axis].is_nan(), "max[{axis}] should be NaN, got {}", bounds.max[axis]);
    }
}

#[test]
fn nan_vertex_excludes_triangle_from_every_query() {
    let mesh = nan_triangle_mesh();
    // A huge query box that would certainly contain the triangle if its
    // bounds were finite (e.g. fabricated from the two non-NaN vertices,
    // which lie inside [-10, 10]^3).
    let huge = Aabb::new([-10.0, -10.0, -10.0], [10.0, 10.0, 10.0]);
    let hits = mesh.query_tris(&huge);
    assert!(hits.is_empty(), "NaN-vertex triangle must not be queryable, got {hits:?}");
}

#[test]
fn clean_triangle_is_still_queryable() {
    // Control: without a NaN vertex, the same-shaped triangle IS found, so
    // the exclusion above is caused by the NaN, not by an unrelated bug.
    #[rustfmt::skip]
    let positions = vec![
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    ];
    let mesh = TriMesh::new(positions, vec![0u32, 1, 2]);
    let huge = Aabb::new([-10.0, -10.0, -10.0], [10.0, 10.0, 10.0]);
    assert_eq!(mesh.query_tris(&huge), vec![0u32]);
}
