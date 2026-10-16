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
//! - KERNEL-30: `boolean` past about 1e77 overflowed f64 intermediates and
//!   panicked in the exact tier. Operands past ±2^128 are now refused
//!   through the existing non-conformity signal; below that, volumes are exact.
//!
//! The implicit points used here sit on exact grid coordinates, so each
//! answer is checked against the explicit predicate on the same point.

use ifc_lite_geometry::kernel::arrangement::{
    boolean, boolean_with_conformity, box_mesh, difference_all, union_all, BoolOp,
};
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

/// Enclosed volume of a closed triangle soup, in units of `s³`.
fn volume_in(tris: &[[[f64; 3]; 3]], s: f64) -> f64 {
    tris.iter()
        .map(|t| {
            let [a, b, c] = t.map(|p| p.map(|v| v / s));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

/// `[0,2s]³ − X` for the transversal cube `[s,3s]³` (volume 7s³), the slab
/// `[s,3s]×[0,2s]×[0,2s]` sharing four planes (4s³), and an off-grid box
/// (8 − 1.1·0.9·1.3 = 6.713 s³).
fn cuts(s: f64) -> [(Vec<[[f64; 3]; 3]>, Vec<[[f64; 3]; 3]>, f64); 3] {
    let a = || box_mesh([0.0; 3], [2.0 * s; 3]);
    [
        (a(), box_mesh([s; 3], [3.0 * s; 3]), 7.0),
        (a(), box_mesh([s, 0.0, 0.0], [3.0 * s, 2.0 * s, 2.0 * s]), 4.0),
        (a(), box_mesh([0.9 * s, 1.1 * s, 0.7 * s], [3.0 * s, 2.6 * s, 2.9 * s]), 6.713),
    ]
}

/// KERNEL-30, inside the admitted range (|coordinate| ≤ 2^128): exact volumes,
/// from unit scale up to cubes whose far corner is 3·2^126.
#[test]
fn issue_7677_kernel_30_boolean_inside_the_coordinate_bound_is_exact() {
    for s in [1.0, 2f64.powi(64), 2f64.powi(126)] {
        for (a, b, want) in cuts(s) {
            let (out, conforming) = boolean_with_conformity(&a, &b, BoolOp::Difference);
            assert!(conforming, "scale {s:e}");
            let got = volume_in(&out, s);
            assert!((got - want).abs() < 1e-9, "scale {s:e}: volume {got}, want {want}");
        }
    }
    // Mixed scales inside the range: a 2^-100 cube inside a 2^100 cube.
    let (h, t) = (2f64.powi(100), 2f64.powi(-100));
    let tiny = box_mesh([-t; 3], [t; 3]);
    let out = boolean(&box_mesh([-h; 3], [h; 3]), &tiny, BoolOp::Intersection);
    assert!((volume_in(&out, t) - 8.0).abs() < 1e-9, "the tiny cube survives the intersection");
}

/// KERNEL-30, past the bound: the boolean is refused through the existing
/// non-conformity signal, never answered with a wrong solid. On base these
/// panicked in the exact tier; with an overflow rescue they returned volumes
/// of 4 and 5.33 where 7 and 4 are right.
#[test]
fn issue_7677_kernel_30_boolean_past_the_coordinate_bound_is_refused() {
    for s in [2f64.powi(200), 2f64.powi(515), 1e300] {
        for (a, b, _) in cuts(s) {
            let (out, conforming) = boolean_with_conformity(&a, &b, BoolOp::Difference);
            assert!(out.is_empty() && !conforming, "scale {s:e}: refused, not a solid of {} tris", out.len());
            assert!(boolean(&a, &b, BoolOp::Union).is_empty(), "scale {s:e}");
            assert!(difference_all(&a, &[&b]).is_none(), "scale {s:e}: difference_all refuses");
            assert!(!union_all(&[&a, &b]).1, "scale {s:e}: union_all reports non-conforming");
        }
    }
    // 1e200 ∩ 1e-200: one operand past the bound refuses the pair.
    let huge = box_mesh([-1e200; 3], [1e200; 3]);
    let tiny = box_mesh([-1e-200; 3], [1e-200; 3]);
    let (out, conforming) = boolean_with_conformity(&huge, &tiny, BoolOp::Intersection);
    assert!(out.is_empty() && !conforming);
}

/// KERNEL-30 through a shipped entry point: wasm `splitMeshByZones` passes
/// zone parameters through, so an `Infinity` size built a box with infinite
/// corners that panicked in the exact tier, and a 1e77 size answered 4 + 4
/// where 8 + 0 is right. Both are now `None` (no split); an in-range huge
/// zone still splits exactly.
#[test]
fn issue_7677_kernel_30_zone_split_refuses_a_zone_past_the_bound() {
    use ifc_lite_geometry::zone_split::{split_mesh_by_zones, ZoneBox, ZoneShape};
    let host = box_mesh([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
    // A quarter-turn-and-a-half keeps `inf * cos ± inf * sin` at ±inf instead
    // of collapsing it to NaN, so the box corners are infinite but ordered.
    let zone = |size: f64| ZoneShape::Box(ZoneBox {
        center: [1.0, 1.0, 1.0],
        size: [size, size, size],
        rotation_y: std::f64::consts::FRAC_PI_4,
    });
    let inside = split_mesh_by_zones(&host, &[zone(1e30)]).expect("an in-range zone splits");
    let in_zone: f64 = inside.pieces.iter().filter(|p| p.zone == Some(0)).map(|p| p.volume).sum();
    assert!((in_zone - 8.0).abs() < 1e-9, "the whole cube is in the zone, got {in_zone}");
    for size in [1e77, f64::INFINITY, f64::NAN] {
        assert!(split_mesh_by_zones(&host, &[zone(size)]).is_none(), "size {size}: refused");
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
    // The largest index: `i * 3` wraps a 32-bit `usize` (wasm32) back into
    // range unless the multiply is checked; here it must simply be outside.
    mesh.indices = vec![0, 1, 2, 0, 1, u32::MAX, 1_431_655_766, 0, 1];
    assert_eq!(mesh.clip_triangles_to_aabb([0.0; 3], [1.0; 3], 0.01), 2);
    assert_eq!(mesh.indices, vec![0, 1, 2]);
}

/// An implicit point whose line is parallel to its plane (`d == 0`) has no
/// position. `orient3d` called it Zero in the leading slot and the
/// segment midpoint's sign elsewhere; every slot now agrees on Zero.
#[test]
fn issue_7677_kernel_27_orient3d_degenerate_implicit_point_is_zero_in_every_slot() {
    let degenerate = ImplicitPoint::Lpi(Lpi {
        p: [0.0, 0.0, 1.0],
        q: [1.0, 0.0, 1.0],
        r: [0.0, 0.0, 0.0],
        s: [1.0, 0.0, 0.0],
        t: [0.0, 1.0, 0.0],
    });
    let (b, c, d) = (e([4.0, 0.0, 0.0]), e([0.0, 4.0, 0.0]), e([0.0, 0.0, 4.0]));
    assert_eq!(orient3d(&degenerate, &b, &c, &d), Sign::Zero);
    assert_eq!(orient3d(&b, &degenerate, &c, &d), Sign::Zero);
    assert_eq!(orient3d(&b, &c, &d, &degenerate), Sign::Zero);
}
