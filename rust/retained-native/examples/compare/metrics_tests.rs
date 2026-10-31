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

// #7955: coincident edges between two closed source solids are not defects.
// Each unit tetrahedron has volume 1/6, so two parts have volume 1/3.
#[test]
fn separate_closed_solids_keep_their_own_edge_multiplicity() {
    let points = [[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]];
    let triangles = [0,2,1,0,1,3,1,2,3,2,0,3];
    let mut measured = Metrics::default();
    measured.add_mesh(&points,&triangles).unwrap();
    measured.add_mesh(&points,&triangles).unwrap();
    assert_eq!(measured.defects,0);
    assert!((measured.volume-1./3.).abs()<1e-15);
}

// #7955: a tetrahedron split into two open patches is closed only in assembly.
// The second patch has a different first point; one common integration origin
// must still recover base area 1/2 times height 1 divided by 3 = 1/6.
#[test]
fn open_band_patches_use_one_origin_and_one_edge_multiset() {
    let a = [[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]];
    let b = [a[1],a[2],a[3],a[0]];
    let mut measured = Metrics::assembly();
    measured.add_mesh(&a,&[0,2,1,0,1,3]).unwrap();
    assert!(measured.defects>0);
    measured.add_mesh(&b,&[0,1,2,1,3,2]).unwrap();
    assert_eq!(measured.defects,0);
    assert!((measured.volume-1./6.).abs()<1e-15);
}
