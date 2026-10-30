// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7781 C2-5a: invariant witnesses for the extracted admission and cutter homes.
//! Synthetic boxes exercise the contracts without a kernel call or model fixture.

use super::super::{admission, CutterKind, GeometryRouter, OpeningFrame};
use crate::{Mesh, Point3, Vector3};

fn partial_axis_coverage<T: admission::Scalar + From<f32>>(tol: T) {
    let zero = T::from(0.0);
    let one = T::from(1.0);
    // Every proper nonempty subset of covered axes must be refused. Exercise
    // missing lower faces and missing upper faces independently; zero slack
    // is deliberately NOT used, so these test the production 3% allowance.
    for mask in 1_u8..7 {
        for miss_upper in [false, true] {
            let lo = std::array::from_fn(|axis| {
                T::from(if mask & (1 << axis) != 0 || miss_upper {
                    0.0
                } else {
                    0.25
                })
            });
            let hi = std::array::from_fn(|axis| {
                T::from(if mask & (1 << axis) != 0 || !miss_upper {
                    1.0
                } else {
                    0.75
                })
            });
            assert!(
                !admission::aabb_engulfs(lo, hi, [zero; 3], [one; 3], tol),
                "partial axis coverage {mask:03b}, miss_upper={miss_upper}, cannot engulf"
            );
        }
    }
}

#[test]
fn c2_5a_partial_axis_coverage_is_not_engulf_f32() {
    partial_axis_coverage(admission::ENGULF_TOLERANCE_F32);
}

#[test]
fn c2_5a_partial_axis_coverage_is_not_engulf_f64() {
    partial_axis_coverage(admission::ENGULF_TOLERANCE);
}

fn complete_and_disjoint_controls<T: admission::Scalar + From<f32>>(tol: T) {
    let zero = T::from(0.0);
    let one = T::from(1.0);
    let two = T::from(2.0);
    let three = T::from(3.0);
    assert!(admission::aabb_engulfs(
        [zero; 3], [one; 3], [zero; 3], [one; 3], tol,
    ));
    assert!(!admission::aabb_engulfs(
        [two; 3], [three; 3], [zero; 3], [one; 3], tol,
    ));
}

#[test]
fn c2_5a_complete_and_disjoint_engulf_controls() {
    complete_and_disjoint_controls(admission::ENGULF_TOLERANCE_F32);
    complete_and_disjoint_controls(admission::ENGULF_TOLERANCE);
}

fn box_mesh(origin: [f64; 3]) -> Mesh {
    let mut mesh =
        GeometryRouter::make_box_mesh(Point3::new(-2.0, -1.0, -0.5), Point3::new(4.0, 3.0, 0.5));
    mesh.origin = origin;
    mesh
}

fn diagonal(origin: [f64; 3]) -> CutterKind {
    let frame = OpeningFrame::from_depth(Vector3::new(0.0, 1.0, 0.0))
        .expect("a unit direction defines a frame");
    CutterKind::DiagonalRectangular(box_mesh(origin), frame)
}

#[test]
fn c2_5a_diagonal_world_bounds_include_f64_origin() {
    // Binary-exact values, with X beyond f32's exact integer range. Widen
    // local positions BEFORE adding the origin; local bounds stay local.
    let kind = diagonal([16_777_217.25, -2000.5, 3000.125]);
    let cutter = kind.cutter();
    assert_eq!(
        cutter.bounds(),
        (Point3::new(-2.0, -1.0, -0.5), Point3::new(4.0, 3.0, 0.5))
    );
    assert_eq!(
        cutter.world_bounds(),
        (
            Point3::new(16_777_215.25, -2001.5, 2999.625),
            Point3::new(16_777_221.25, -1997.5, 3000.625),
        ),
        "diagonal world bounds must restore the origin in f64"
    );
}

#[test]
fn c2_5a_zero_origin_diagonal_bounds_agree() {
    let kind = diagonal([0.0; 3]);
    let expected = (Point3::new(-2.0, -1.0, -0.5), Point3::new(4.0, 3.0, 0.5));
    assert_eq!(kind.cutter().bounds(), expected);
    assert_eq!(kind.cutter().world_bounds(), expected);
}

#[test]
fn c2_5a_nonrectangular_world_bounds_use_payload() {
    // Unlike diagonal meshes, these bounds are the classification payload:
    // neither recompute the mesh's smaller box nor add its origin twice.
    let expected = (
        Point3::new(-20.0, -10.0, -5.0),
        Point3::new(40.0, 30.0, 5.0),
    );
    let kind = CutterKind::NonRectangular(
        box_mesh([100.0, 200.0, 300.0]),
        expected.0,
        expected.1,
        None,
    );
    assert_eq!(kind.cutter().bounds(), expected);
    assert_eq!(kind.cutter().world_bounds(), expected);
}
