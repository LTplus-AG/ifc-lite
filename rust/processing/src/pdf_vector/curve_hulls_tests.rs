// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
#[test]
fn issue_4406_shared_chord_accepts_opposite_sides_but_not_same_side_or_two_lines() {
    let upper = vec![[0., 0.], [0., 2.], [2., 2.], [2., 0.]];
    let lower = vec![[2., 0.], [2., -2.], [0., -2.], [0., 0.]];
    assert!(qualify(&[upper.clone(), lower], &mut 10000).is_ok());
    let same = vec![[2., 0.], [2., 1.], [0., 1.], [0., 0.]];
    assert!(qualify(&[upper, same], &mut 10000).is_err());
    assert!(qualify(
        &[vec![[0., 0.], [2., 0.]], vec![[2., 0.], [0., 0.]]],
        &mut 10000
    )
    .is_err());
}
#[test]
fn issue_4406_nonadjacent_hulls_may_not_share_endpoints_or_overlap() {
    let figure_eight = vec![
        vec![[0., 0.], [-1., 1.], [-1., -1.], [0., 0.]],
        vec![[0., 0.], [1., 1.], [1., -1.], [0., 0.]],
        vec![[0., 0.], [0., 2.]],
        vec![[0., 2.], [0., 0.]],
    ];
    assert!(qualify(&figure_eight, &mut 10000).is_err());
    assert!(!strictly_separated(
        &vec![[0., 0.], [2., 0.], [0., 2.]],
        &vec![[1., 0.], [3., 0.], [1., 2.]]
    ));
}
#[test]
fn issue_4406_hull_proof_charges_before_quadratic_pairs() {
    let pieces = vec![
        vec![[0., 0.], [1., 0.]],
        vec![[1., 0.], [0., 1.]],
        vec![[0., 1.], [0., 0.]],
    ];
    assert!(qualify(&pieces, &mut 1).unwrap_err().contains("budget"));
}

#[test]
fn issue_4406_exact_collinear_monotone_bezier_is_a_line_but_backtracking_refuses() {
    assert!(convex(&[[0., 0.], [1., 1.], [2., 2.], [3., 3.]], &mut 100).is_ok());
    assert!(convex(&[[0., 0.], [4., 4.], [2., 2.], [3., 3.]], &mut 100).is_err());
}
