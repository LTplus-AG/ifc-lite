// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7677: public exact-kernel entry points that panicked on legal caller
//! input. The release profile is `panic = 'abort'`, so each of these killed
//! the whole wasm instance instead of answering.
//!
//! - KERNEL-27: `orient2d` / `orient3d` hit `unimplemented!` for an implicit
//!   point outside the leading slot, and `orient2d_2i` / `orient2d_3i` hit
//!   `unreachable!` for an `Explicit` argument.
//! - KERNEL-30: `boolean` over large finite coordinates overflowed the
//!   crossing-line direction to `inf`, which panicked in the exact tier.
//!
//! The implicit points used here sit on exact grid coordinates, so each
//! answer is checked against the explicit predicate on the same point.

use ifc_lite_geometry::kernel::arrangement::{boolean, box_mesh, BoolOp};
use ifc_lite_geometry::kernel::predicates::{orient2d, orient2d_2i, orient2d_3i, orient2d_any, orient3d};
use ifc_lite_geometry::kernel::{DropAxis, ImplicitPoint, Lpi, Sign};

/// The vertical line through `(x, y)` meets the plane `z = 0` at `(x, y, 0)`.
fn lpi_at(x: f64, y: f64) -> ImplicitPoint {
    ImplicitPoint::Lpi(Lpi {
        p: [x, y, -1.0],
        q: [x, y, 1.0],
        r: [0.0, 0.0, 0.0],
        s: [1.0, 0.0, 0.0],
        t: [0.0, 1.0, 0.0],
    })
}

/// The same point from the reversed line, so its denominator changes sign.
fn lpi_reversed(x: f64, y: f64) -> ImplicitPoint {
    let ImplicitPoint::Lpi(mut l) = lpi_at(x, y) else { unreachable!() };
    std::mem::swap(&mut l.p, &mut l.q);
    ImplicitPoint::Lpi(l)
}

fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

#[test]
fn issue_7677_kernel_27_orient2d_accepts_an_implicit_point_in_any_slot() {
    let (a, b, c) = ([0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]);
    let expected = orient2d(&e(a), &e(b), &e(c), DropAxis::Z);
    assert_ne!(expected, Sign::Zero);
    let b_implicit = lpi_at(4.0, 0.0);
    assert_eq!(orient2d(&e(a), &b_implicit, &e(c), DropAxis::Z), expected);
    assert_eq!(orient2d(&e(a), &e(b), &lpi_at(0.0, 4.0), DropAxis::Z), expected);
    assert_eq!(orient2d(&lpi_at(0.0, 0.0), &b_implicit, &e(c), DropAxis::Z), expected);
    assert_eq!(orient2d_any(&e(a), &b_implicit, &e(c), DropAxis::Z), expected);
    // The 2I/3I entry points take any point kind; an Explicit one is (p, 1).
    assert_eq!(orient2d_2i(&e(a), &e(b), c, DropAxis::Z), expected);
    assert_eq!(orient2d_3i(&e(a), &b_implicit, &e(c), DropAxis::Z), expected);
}

#[test]
fn issue_7677_kernel_27_orient3d_accepts_an_implicit_point_in_any_slot() {
    let (a, b, c, d) = ([0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 4.0]);
    let expected = orient3d(&e(a), &e(b), &e(c), &e(d));
    assert_ne!(expected, Sign::Zero);
    let (ai, bi, ci) = (lpi_at(0.0, 0.0), lpi_at(4.0, 0.0), lpi_at(0.0, 4.0));
    assert_eq!(orient3d(&ai, &e(b), &e(c), &e(d)), expected, "the leading-slot case is unchanged");
    assert_eq!(orient3d(&e(a), &bi, &e(c), &e(d)), expected);
    assert_eq!(orient3d(&e(a), &e(b), &ci, &e(d)), expected);
    assert_eq!(orient3d(&ai, &bi, &ci, &e(d)), expected);
    assert_eq!(orient3d(&e(a), &lpi_reversed(4.0, 0.0), &e(c), &e(d)), expected);
    assert_eq!(orient3d(&ai, &lpi_reversed(4.0, 0.0), &ci, &e(d)), expected);
    assert_eq!(orient3d(&e(b), &e(a), &ci, &e(d)), expected.flip(), "one transposition flips the sign");
    // A point on the plane of the other three is exactly coplanar.
    assert_eq!(orient3d(&ai, &bi, &ci, &lpi_at(1.0, 1.0)), Sign::Zero);
}

#[test]
fn issue_7677_kernel_30_boolean_over_large_finite_coordinates_answers() {
    // Plane normals of these boxes are ~1e160, so their cross product is
    // +inf in f64. Coordinates are powers of two times small integers, so
    // scaling the whole problem by 2^-k is exact.
    let s = 2f64.powi(270);
    let a = box_mesh([0.0, 0.0, 0.0], [2.0 * s, 2.0 * s, 2.0 * s]);
    let b = box_mesh([s, s, s], [3.0 * s, 3.0 * s, 3.0 * s]);
    let out = boolean(&a, &b, BoolOp::Difference);
    assert!(!out.is_empty(), "A - B of overlapping boxes is not empty");
    assert!(out.iter().flatten().flatten().all(|v| v.is_finite()));
    // The same problem at unit scale has the same number of triangles.
    let unit = boolean(
        &box_mesh([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]),
        &box_mesh([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]),
        BoolOp::Difference,
    );
    assert_eq!(out.len(), unit.len());
}

/// KERNEL-30's coplanar sibling: past ~1e154 a triangle's own plane normal
/// overflows, which the coplanar clip used to carry into an implicit point.
#[test]
fn issue_7677_kernel_30_coplanar_boolean_over_huge_finite_coordinates_answers() {
    let cut = |s: f64| {
        // Shares the y = 0, y = 2s, z = 0 and z = 2s planes with `a`.
        let a = box_mesh([0.0, 0.0, 0.0], [2.0 * s, 2.0 * s, 2.0 * s]);
        let b = box_mesh([s, 0.0, 0.0], [3.0 * s, 2.0 * s, 2.0 * s]);
        boolean(&a, &b, BoolOp::Difference)
    };
    let (unit, huge) = (cut(1.0), cut(2f64.powi(515)));
    assert!(!unit.is_empty(), "A - B keeps the left half");
    assert!(huge.iter().flatten().flatten().all(|v| v.is_finite()));
    assert_eq!(huge.len(), unit.len(), "the scaled problem has the same topology");
}

/// KERNEL-30 through a shipped entry point: wasm `splitMeshByZones` filters
/// non-finite host vertices but passes zone parameters through, so a zone of
/// `Infinity` size built a box with `inf`/`NaN` corners that panicked in the
/// exact tier. A non-finite zone now reaches nothing; the element stays whole.
#[test]
fn issue_7677_kernel_30_zone_split_ignores_a_non_finite_zone() {
    use ifc_lite_geometry::zone_split::{split_mesh_by_zones, ZoneBox, ZoneShape};
    let host = box_mesh([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
    // A quarter-turn-and-a-half keeps `inf * cos ± inf * sin` at ±inf instead
    // of collapsing it to NaN, so the box corners are infinite but ordered.
    let zone = |size: f64| ZoneShape::Box(ZoneBox {
        center: [1.0, 1.0, 1.0],
        size: [size, 1.0, 1.0],
        rotation_y: std::f64::consts::FRAC_PI_4,
    });
    let finite = split_mesh_by_zones(&host, &[zone(1.0)]).expect("a closed host splits");
    assert_eq!(finite.pieces.iter().filter(|p| p.zone == Some(0)).count(), 1);
    for size in [f64::INFINITY, f64::NAN] {
        let split = split_mesh_by_zones(&host, &[zone(size)]).expect("a closed host splits");
        assert!(split.pieces.iter().all(|p| p.zone.is_none()), "size {size}: {:?}", split.pieces.len());
        let whole: f64 = split.pieces.iter().map(|p| p.volume).sum();
        assert!((whole - 8.0).abs() < 1e-9, "size {size}: the remainder is the whole element, got {whole}");
    }
}

/// KERNEL-28: `Mesh` has pub fields, so a caller can hand `clip_triangles_to_aabb`
/// an index past the vertex buffer. That triangle is now dropped like one
/// poking outside the box, instead of indexing out of bounds.
#[test]
fn issue_7677_kernel_28_clip_to_aabb_drops_an_out_of_range_triangle() {
    let mut mesh = ifc_lite_geometry::Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    mesh.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    mesh.indices = vec![0, 1, 2, 0, 1, 7];
    assert_eq!(mesh.clip_triangles_to_aabb([0.0; 3], [1.0; 3], 0.01), 1);
    assert_eq!(mesh.indices, vec![0, 1, 2]);
    assert_eq!(mesh.positions.len(), 9);
}
