// SPDX-License-Identifier: MPL-2.0
use super::*;

// #8183: fold the lower apex of a closed triangular bipyramid above its base.
// The overlapping tetrahedra contribute +1/6 and -1/12, not their absolute sum.
#[test]
fn folded_closed_mesh_cancels_signed_tetrahedra_before_absolute_volume() {
    let points = [
        [0., 0., 0.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [0., 0., 0.5],
    ];
    let indices = [0, 1, 3, 1, 2, 3, 2, 0, 3, 1, 0, 4, 2, 1, 4, 0, 2, 4];
    let mut measured = Metrics::default();
    measured.add_mesh(&points, &indices).unwrap();
    assert_eq!(measured.defects, 0);
    assert!((measured.volume - 1. / 12.).abs() < 1e-15);
    assert!((measured.volume - 1. / 4.).abs() > 0.1);
    let reversed: Vec<_> = indices
        .chunks_exact(3)
        .flat_map(|t| [t[0], t[2], t[1]])
        .collect();
    let mut reverse = Metrics::default();
    reverse.add_mesh(&points, &reversed).unwrap();
    assert_eq!(reverse.volume, measured.volume);
}

// #8183: min/max reduction must not erase an invalid coordinate difference.
#[test]
fn nonfinite_bbox_comparison_cannot_appear_exact() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let a = [bad, 0., 0., 1., 1., 1.];
        assert!(!bbox_deviation(&a, &a).is_finite());
    }
}
