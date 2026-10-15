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
        !Edges::new(host.iter()).closed_edge_incidence()
            || !Edges::new(cutter.iter()).closed_edge_incidence(),
        "{label}: witness must fail original-operand admission"
    );
    let (old_moves, old) = established(host, cutter);
    assert!(old_moves > 0, "{label}: established weld must actually act");
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
        assert!(Edges::new(h.iter()).closed_edge_incidence());
        assert!(Edges::new(c.iter()).closed_edge_incidence());
        if translated {
            assert!(bits(&h).contains(&(-0.0_f64).to_bits()));
            assert!(bits(&h).contains(&0.0_f64.to_bits()));
        }
        assert!(
            established(&h, &c).0 > 0,
            "positive must distinguish the new refusal"
        );
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
    assert!(!Edges::new(std::iter::once(&t)).closed_edge_incidence());
    assert!(!Edges::new([].iter()).closed_edge_incidence());
}

#[test]
fn issue_7635_unrelated_invalid_faces_do_not_erase_local_arrises() {
    let a = [0., 0., 0.];
    let b = [0., 0., 1.];
    let face = [a, [1., 0., 0.], b];
    let cutter = crate::kernel::arrangement::box_mesh([0., 0., -1.], [1., 1., 2.]);
    let v = [0., 0., 2.];
    assert!(super::CutterEdges::new(&cutter).contains(&v, &a, &b, &face));
    for extra in [
        [[4., 4., 4.], [5., 4., 4.], [6., 4., 4.]],
        [[f64::NAN, 4., 4.], [5., 4., 4.], [6., 4., 5.]],
        [[f64::INFINITY, 4., 4.], [5., 4., 4.], [6., 4., 5.]],
    ] {
        let mut mixed = cutter.clone();
        mixed.push(extra);
        let edges = super::CutterEdges::new(&mixed);
        assert!(!edges.closed_edge_incidence());
        assert!(edges.contains(&v, &a, &b, &face));
    }
}
