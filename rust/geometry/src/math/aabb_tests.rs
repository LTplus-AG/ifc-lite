// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `Aabb3`: fold semantics (NaN skipped), well-formedness, f32 widening.

use super::aabb::Aabb3;
use super::v3_tests::Rng;

#[test]
fn from_points_matches_the_inline_fold_it_replaces() {
    let mut rng = Rng(42);
    for n in 0..200 {
        let pts: Vec<[f64; 3]> = (0..n).map(|_| rng.v3()).collect();
        let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for p in &pts {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let b = Aabb3::from_points(pts.iter().copied());
        for k in 0..3 {
            assert_eq!(b.min[k].to_bits(), lo[k].to_bits());
            assert_eq!(b.max[k].to_bits(), hi[k].to_bits());
        }
    }
}

#[test]
fn empty_is_the_identity_and_is_not_well_formed() {
    let b = Aabb3::from_points([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]);
    assert_eq!(Aabb3::EMPTY.union(&b), b);
    assert_eq!(b.union(&Aabb3::EMPTY), b);
    assert!(!Aabb3::EMPTY.is_well_formed());
    assert!(!Aabb3::EMPTY.overlaps(&b));
    assert!(!Aabb3::from_points([]).is_well_formed());
}

#[test]
fn a_nan_axis_is_skipped_and_the_partial_box_is_not_published() {
    // NaN on y only: x and z accumulate, y stays at its sentinel.
    let b = Aabb3::from_points([[1.0, f64::NAN, 2.0], [3.0, f64::NAN, 4.0]]);
    assert_eq!((b.min[0], b.max[0], b.min[2], b.max[2]), (1.0, 3.0, 2.0, 4.0));
    assert_eq!((b.min[1], b.max[1]), (f64::INFINITY, f64::NEG_INFINITY));
    assert!(!b.is_well_formed());
    let inf = Aabb3::from_points([[0.0, 0.0, f64::INFINITY]]);
    assert!(!inf.is_well_formed(), "an infinite axis is not publishable");
    assert!(Aabb3::from_points([[1.0, 1.0, 1.0]]).is_well_formed(), "a point is a box");
}

#[test]
fn overlap_is_closed() {
    let a = Aabb3::from_array6([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    let touching = Aabb3::from_array6([1.0, 0.0, 0.0, 2.0, 1.0, 1.0]);
    let apart = Aabb3::from_array6([1.5, 0.0, 0.0, 2.0, 1.0, 1.0]);
    assert!(a.overlaps(&touching) && touching.overlaps(&a));
    assert!(!a.overlaps(&apart));
}

#[test]
fn f32_positions_widen_exactly_and_ignore_a_partial_tail() {
    let pos = [0.1f32, -0.2, 0.3, 4.0, 5.0, -6.0, 99.0, 99.0];
    let b = Aabb3::from_f32_positions(&pos);
    assert_eq!(b.to_array6(), [0.1f32 as f64, -0.2f32 as f64, -6.0, 4.0, 5.0, 0.3f32 as f64]);
    assert_eq!(Aabb3::from_f32_positions(&[1.0, 2.0]), Aabb3::EMPTY);
}

#[test]
fn array6_round_trips() {
    let a = [1.0, -2.0, 3.0, 4.0, 5.0, 6.0];
    assert_eq!(Aabb3::from_array6(a).to_array6(), a);
}
