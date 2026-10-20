// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7635: only the additional finite refusal requires closed original operands.
use super::{opening_cutter, reduced_host, Edges, Tri};
use crate::kernel::plane_weld::{promote, promote_subtract_cutter_onto_host_faces};

fn bits(tris: &[Tri]) -> Vec<u64> {
    tris.iter()
        .flatten()
        .flatten()
        .map(|x| x.to_bits())
        .collect()
}

fn established(host: &[Tri], cutter: &[Tri]) -> (usize, Vec<Tri>) {
    let mut output = cutter.to_vec();
    // The same implementation with only the pre-existing coincidence rule.
    let moved = promote::<true, false>(&mut output, host);
    (moved, output)
}

fn preserves_established(label: &str, host: &[Tri], cutter: &[Tri]) {
    assert!(
        !Edges::new(host.iter()).expect("normal finite guard work").closed_edge_incidence()
            || !Edges::new(cutter.iter()).expect("normal finite guard work").closed_edge_incidence(),
        "{label}: witness must fail original-operand admission"
    );
    let (old_moves, old) = established(host, cutter);
    // Current main can already refuse this captured witness. Preserve its
    // actual decisions and every coordinate bit for uncertified operands.
    let mut current = cutter.to_vec();
    let moves = promote_subtract_cutter_onto_host_faces(&mut current, host);
    assert_eq!(moves, old_moves, "{label}: preserve established decisions");
    assert_eq!(
        bits(&current),
        bits(&old),
        "{label}: preserve every coordinate bit"
    );
}

#[test]
fn issue_7635_uncertified_original_operands_retain_established_weld() {
    let host = reduced_host();
    let cutter = opening_cutter();
    for host_operand in [true, false] {
        let original = if host_operand { &host } else { &cutter };
        let mut cases = Vec::new();
        let mut open = original.clone();
        open.remove(0); // A cap triangle, leaving the local wall arris available.
        cases.push(("open", open));
        let mut reversed = original.clone();
        reversed[0].swap(1, 2);
        cases.push(("same-direction edge pair", reversed));
        let mut doubled = original.clone();
        doubled.extend_from_slice(original);
        cases.push(("two opposite pairs", doubled));
        for (label, triangle) in [
            (
                "distinct collinear vertices",
                [[26., 18., 4.], [27., 18., 4.], [28., 18., 4.]],
            ),
            (
                "repeated vertex",
                [[26., 18., 4.], [26., 18., 4.], [28., 18., 4.]],
            ),
            ("NaN", [[f64::NAN, 18., 4.], [27., 18., 4.], [28., 18., 5.]]),
            (
                "infinity",
                [[f64::INFINITY, 18., 4.], [27., 18., 4.], [28., 18., 5.]],
            ),
        ] {
            let mut bad = original.clone();
            bad.push(triangle);
            cases.push((label, bad));
        }
        for (label, bad) in cases {
            let context = format!("{label}, host_operand={host_operand}");
            let (h, c) = if host_operand {
                (&bad[..], &cutter[..])
            } else {
                (&host[..], &bad[..])
            };
            preserves_established(&context, h, c);
        }
    }
}

#[test]
fn issue_7635_closed_original_operands_admit_finite_refusal_and_fold_signed_zero() {
    let host = reduced_host();
    let cutter = opening_cutter();
    for translated in [false, true] {
        let offset = if translated { host[0][0] } else { [0.; 3] };
        let shift = |tris: &[Tri]| -> Vec<Tri> {
            tris.iter()
                .enumerate()
                .map(|(i, t)| {
                    t.map(|p| {
                        std::array::from_fn(|k| {
                            let v = p[k] - offset[k];
                            if v == 0.0 && i % 2 == 0 {
                                -0.0
                            } else {
                                v
                            }
                        })
                    })
                })
                .collect()
        };
        let (h, c) = (shift(&host), shift(&cutter));
        assert!(Edges::new(h.iter()).expect("normal finite guard work").closed_edge_incidence());
        assert!(Edges::new(c.iter()).expect("normal finite guard work").closed_edge_incidence());
        if translated {
            assert!(bits(&h).contains(&(-0.0_f64).to_bits()));
            assert!(bits(&h).contains(&0.0_f64.to_bits()));
        }
        // Current main already refuses these captured movements. The direct
        // finite_certificate_is_distinct_from_mutual_plane_coincidence test
        // supplies the positive certificate witness; retain end-to-end safety.
        assert_eq!(established(&h, &c).0, 0);
        let mut current = c.clone();
        assert_eq!(promote_subtract_cutter_onto_host_faces(&mut current, &h), 0);
        assert_eq!(bits(&current), bits(&c));
    }
}

#[test]
fn issue_7635_finite_predicate_overflow_is_uncertified() {
    // All coordinates are finite, but no projected orientation provides a
    // finite nonzero witness. Declining says nothing about solid validity.
    let t = [
        [f64::MAX, f64::MAX, 0.],
        [-f64::MAX, f64::MAX, 0.],
        [0., -f64::MAX, 0.],
    ];
    assert!(!super::noncollapsed(&t));
    assert!(!Edges::new(std::iter::once(&t)).expect("normal finite guard work").closed_edge_incidence());
    assert!(!Edges::new([].iter()).expect("normal finite guard work").closed_edge_incidence());
}

#[test]
fn issue_7635_unrelated_invalid_faces_do_not_erase_local_arrises() {
    let a = [0., 0., 0.];
    let b = [0., 0., 1.];
    let face = [a, [1., 0., 0.], b];
    let cutter = crate::kernel::arrangement::box_mesh([0., 0., -1.], [1., 1., 2.]);
    let v = [0., 0., 2.];
    assert!(super::CutterEdges::new(&cutter).expect("normal finite guard work").contains(&v, &a, &b, &face).expect("normal finite guard work"));
    for extra in [
        [[4., 4., 4.], [5., 4., 4.], [6., 4., 4.]],
        [[f64::NAN, 4., 4.], [5., 4., 4.], [6., 4., 5.]],
        [[f64::INFINITY, 4., 4.], [5., 4., 4.], [6., 4., 5.]],
    ] {
        let mut mixed = cutter.clone();
        mixed.push(extra);
        let edges = super::CutterEdges::new(&mixed).expect("normal finite guard work");
        assert!(!edges.closed_edge_incidence());
        assert!(edges.contains(&v, &a, &b, &face).expect("normal finite guard work"));
    }
}

#[test]
fn issue_7635_no_proposed_weld_does_not_charge_finite_index() {
    use crate::kernel::budget::{self, incidence_work};
    let host = crate::kernel::arrangement::box_mesh([0., 0., 0.], [10., 1., 10.]);
    // A through-wall cutter whose corners are nowhere near any host plane.
    let cutter = crate::kernel::arrangement::box_mesh([2., -1., 2.], [3., 2., 3.]);
    incidence_work::with_limit(0, || {
        budget::begin();
        let mut actual = cutter.clone();
        assert_eq!(promote_subtract_cutter_onto_host_faces(&mut actual, &host), 0);
        assert_eq!(bits(&actual), bits(&cutter));
        assert!(!budget::tripped(), "a no-op weld must not build finite indexes");
    });
}

#[test]
fn issue_7635_closed_edge_contact_exercises_production_finite_refusal() {
    let g = 1. / 65536.;
    // Source walls share only their finite arris with the cutter, rather than
    // positive face area: the established overlap guard cannot mask this rule.
    let mut host = crate::kernel::arrangement::box_mesh([-1., -1., 0.], [0., 0., 1.]);
    let [a, b, c, d] = [
        [3., 4. * g, 0.], [30., 31. * g, 0.],
        [3., 4. * g, 1.], [3., 1., 0.],
    ];
    host.extend([[a, b, c], [a, d, b], [b, d, c], [c, d, a]]);
    let cutter = crate::kernel::arrangement::box_mesh([0., 0., -1.], [1., 1., 2.]);
    assert!(Edges::new(host.iter()).expect("closed host index").closed_edge_incidence());
    assert!(Edges::new(cutter.iter()).expect("closed cutter index").closed_edge_incidence());
    let (ordinary_moves, ordinary) = established(&host, &cutter);
    assert!(ordinary_moves > 0, "ordinary path must actually move the arris");
    assert_ne!(bits(&ordinary), bits(&cutter));
    let mut opening = cutter.clone();
    let opening_moves = promote_subtract_cutter_onto_host_faces(&mut opening, &host);
    assert!(opening_moves < ordinary_moves, "production opening guard must refuse a real movement");
    for (original, actual) in cutter.iter().flatten().zip(opening.iter().flatten()) {
        if original[0] == 0. && original[1] == 0. {
            assert_eq!(original.map(f64::to_bits), actual.map(f64::to_bits), "retain original finite arris");
        }
    }
}
