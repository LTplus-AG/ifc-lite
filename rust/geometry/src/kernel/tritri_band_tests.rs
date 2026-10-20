// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7292 / review4302952513: global uncertainty cannot erase a real crossing.
use super::*;
use crate::kernel::{arrangement, budget, rational};
use num_rational::BigRational;
use num_traits::ToPrimitive;
use std::collections::BTreeMap;

const A: [[f64; 3]; 3] = [[0., -1., -1.], [0., 1., -1.], [0., 0., 1.]];
const B: [[f64; 3]; 3] = [[-0.1875, -1., -1.], [0.1875, 1., -1.], [0., 0., 1.]];
const REMOTE: [[f64; 3]; 3] = [[10_000_000., 10_000_000., 0.],
    [10_000_001., 10_000_000., 0.], [10_000_000., 10_000_001., 0.]];
fn coords(p: &ImplicitPoint) -> [f64; 3] {
    rational::point_of(p).map(|v| v.to_f64().expect("finite dyadic test intersection"))
}

#[test]
fn issue_7292_global_band_keeps_a_real_transverse_segment() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    let local = NearBand::from_operands(&[A], &[B]);
    let shared = NearBand::from_operands(&[A, REMOTE], &[B]);
    assert!(!near_coplanar(&A, &B, &local));
    assert!(near_coplanar(&A, &B, &shared));
    assert!(arrangement::coincident_planes(plane_normal(&A), plane_normal(&B)));
    assert!(matches!(tri_tri_intersection(&A, &B), TriTri::Segment(_)));
    match tri_tri_intersection_with_band(&A, &B, &shared) {
        TriTri::Segment([p, q]) => {
            let mut points = [coords(&p), coords(&q)];
            points.sort_by(|a, b| crate::cmp_f64_nan_last(a[2], b[2]));
            assert_eq!(points, [[0., 0., -1.], [0., 0., 1.]]);
        }
        other => panic!("unrelated operand extent erased the actual transverse segment: {other:?}"),
    }
    assert!(!budget::tripped());
}

#[test]
fn issue_7292_global_band_binary_caller_keeps_the_transverse_cut() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    assert!(arrangement::operands_admitted(&[&[A, REMOTE], &[B]]));
    let arr = arrangement::arrange(&[A, REMOTE], &[B]);
    assert_eq!(arr.unrecovered, 0);
    for tris in [&arr.tris_a, &arr.tris_b] {
        assert!(tris.iter().any(|tri| {
            let points = tri.map(|v| coords(arr.interner.get(v)));
            points.contains(&[0., 0., -1.]) && points.contains(&[0., 0., 1.])
        }), "actual binary caller must recover the full transverse cut on BOTH operands");
    }
    assert!(!budget::tripped());
}

/// The historical paired-band positive was parallel Y0/Y16delta, not tilted.
/// Include tilted parallel planes and opposite windings without an angle epsilon.
#[test]
fn issue_7292_global_band_preserves_parallel_offset_positive_controls() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    for a in [A, [[-1., -1., -1.], [1., 1., -1.], [0., 0., 1.]]] {
        let offset = a.map(|p| [p[0] + 1. / 4096., p[1], p[2]]);
        for b in [offset, [offset[0], offset[2], offset[1]]] {
            let local = NearBand::from_operands(&[a], &[b]);
            let shared = NearBand::from_operands(&[a, REMOTE], &[b]);
            assert!(!near_coplanar(&a, &b, &local));
            assert!(matches!(tri_tri_intersection(&a, &b), TriTri::None));
            assert!(matches!(tri_tri_intersection_with_band(&a, &b, &shared), TriTri::Coplanar));
        }
    }
    assert!(!budget::tripped());
}

#[test]
fn issue_7292_global_band_keeps_the_legacy_local_tilted_noise_slab() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    let d = 1. / 65536.;
    let b = [[-d, -1., -1.], [d, 1., -1.], [0., 0., 1.]];
    let local = NearBand::from_operands(&[A], &[b]);
    let shared = NearBand::from_operands(&[A, REMOTE], &[b]);
    assert!(near_coplanar(&A, &b, &local));
    assert!(matches!(tri_tri_intersection(&A, &b), TriTri::Coplanar));
    assert!(matches!(tri_tri_intersection_with_band(&A, &b, &shared), TriTri::Coplanar));
    assert!(!budget::tripped());
}

fn strict_edges(tris: &[[[f64; 3]; 3]]) -> usize {
    let mut uses = BTreeMap::new();
    for t in tris { for k in 0..3 {
        let key = |p: [f64; 3]| p.map(|x| if x == 0. { 0 } else { x.to_bits() });
        *uses.entry((key(t[k]), key(t[(k + 1) % 3]))).or_insert(0usize) += 1;
    }}
    uses.iter().filter(|&((a, b), &n)| n != 1 || uses.get(&(*b, *a)).copied() != Some(1)).count()
}
fn volume6(tris: &[[[f64; 3]; 3]]) -> BigRational {
    tris.iter().map(|t| {
        let [a, b, c] = t.map(|p| p.map(|x| BigRational::from_float(x).expect("finite Boolean output")));
        &a[0] * (&b[1] * &c[2] - &b[2] * &c[1])
            + &a[1] * (&b[2] * &c[0] - &b[0] * &c[2])
            + &a[2] * (&b[0] * &c[1] - &b[1] * &c[0])
    }).sum()
}

/// Reuse the actual historical full Boolean positive, including remote/empty
/// component ordering. A distant disjoint cutter cannot erase a local slab.
#[test]
fn issue_7292_global_band_parallel_components_keep_the_closed_boolean_slab() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    let d = 16. / 65536.;
    let a = arrangement::box_mesh([0.; 3], [1.; 3]);
    let b = arrangement::box_mesh([0., d, 0.], [1., 2., 1.]);
    let far = arrangement::box_mesh([0., 4096., 0.], [1., 4112., 1.]);
    let empty = Vec::new();
    for components in [vec![b.as_slice()], vec![b.as_slice(), far.as_slice()],
        vec![far.as_slice(), empty.as_slice(), b.as_slice()]] {
        budget::begin();
        let (output, _, conforming) = arrangement::difference_all_lenient_with_conformity(&a, &components);
        assert!(conforming && !budget::tripped());
        assert_eq!(strict_edges(&output), 0);
        assert_eq!(volume6(&output), BigRational::from_float(6. * d).unwrap());
        assert!(output.iter().flatten().all(|p| p[1] >= 0. && p[1] <= d));
    }
}


// #7292 / review4302952513: full Boolean negative, not only tri-tri recovery.
#[test]
fn issue_7292_global_band_remote_component_keeps_the_analytic_boolean_cut() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element();
    let host = arrangement::box_mesh([-1.; 3], [1.; 3]);
    let cutter: Vec<_> = arrangement::box_mesh([0., -2., -2.], [3., 2., 2.])
        .into_iter().map(|t| t.map(|p| [p[0] + 3. * p[1] / 16., p[1], p[2]])).collect();
    let far = arrangement::box_mesh([10_000_000., 0., 0.], [10_000_001., 1., 1.]);
    // Keep far and local in ONE binary operand: separate N-ary components have
    // separate bands and would fail to exercise the remote extent influence.
    let joined: Vec<_> = cutter.iter().chain(&far).copied().collect();
    let reversed: Vec<_> = far.iter().chain(&cutter).copied().collect();
    for (name, b) in [("local", &cutter), ("local_then_remote", &joined), ("remote_then_local", &reversed)] {
        budget::begin();
        let (output, conforming) = arrangement::boolean_with_conformity(
            &host, b, arrangement::BoolOp::Difference);
        assert!(conforming && !budget::tripped(), "{name}: exact arrangement must conform within budget");
        assert!(!output.is_empty());
        assert_eq!(strict_edges(&output), 0, "{name}: every directed boundary edge must have one opposite use");
        // Integral over y,z in [-1,1]^2 of (1+3y/16) is 4.
        assert_eq!(volume6(&output), BigRational::from_integer(24.into()), "{name}: analytic retained volume must be four");
        assert!(output.iter().flatten().all(|p| p[0] <= 3. * p[1] / 16.), "{name}: no retained boundary may lie inside the cutter");
    }
}

/// Exact symbolic-plane admission must neither round a valid construction nor
/// accept point_of's finite average for an undefined LPI/TPI construction.
#[test]
fn issue_7292_global_band_symbolic_parallel_certificate_refuses_undefined_points() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let _element = budget::enter_element(); budget::begin();
    let p = e([1., 0., 0.]);
    let q = ImplicitPoint::Lpi(Lpi { p: [1., 0., 0.], q: [1., 1., 0.],
        r: [2., 0., 0.], s: [-1., 1., 0.], t: [2., 0., 1.] }); // (1,1/3,0)
    let planes = [
        [[1., 0., 0.], [1., 1., 0.], [1., 0., 1.]],
        [[0., 0., 0.], [1., 0., 0.], [0., 0., 1.]],
        [[0., 0., 1.], [1., 0., 1.], [0., 1., 1.]],
    ];
    let r = ImplicitPoint::Tpi(crate::kernel::Tpi { planes }); // (1,0,1)
    assert!(exactly_parallel_symbolic_plane([&p, &q, &r], &A));
    assert!(exactly_parallel_symbolic_plane([&r, &q, &p], &A));
    assert!(!exactly_parallel_symbolic_plane([&p, &q, &r], &B));
    let invalid_lpi = ImplicitPoint::Lpi(Lpi { p: [1., 0., 0.], q: [1., 1., 0.],
        r: A[0], s: A[1], t: A[2] });
    assert!(!exactly_parallel_symbolic_plane([&p, &invalid_lpi, &r], &A));
    let invalid_tpi = ImplicitPoint::Tpi(crate::kernel::Tpi { planes: [planes[0]; 3] });
    assert!(!exactly_parallel_symbolic_plane([&p, &q, &invalid_tpi], &A));
    let invalid_explicit = e([f64::NAN, 0., 0.]);
    assert!(!exactly_parallel_symbolic_plane([&invalid_explicit, &q, &r], &A));
    assert!(!budget::tripped());
}
