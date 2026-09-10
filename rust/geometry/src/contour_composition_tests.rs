// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn rectangle(x: f64, y: f64, w: f64, h: f64) -> Ring2D {
    vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        .into_iter()
        .map(|[x, y]| [0.04 * y - 0.8, 4.4 - 0.04 * x])
        .collect()
}
#[test]
fn issue_4458_shared_edge_stays_identical_after_sequential_classification_and_clipping() {
    let source = vec![rectangle(90., 60., 20., 30.)];
    let clip = vec![rectangle(10., 20., 100., 72.)];
    let grid = 0.001 / (12. * 16.);
    let mut c = FixedGridComposition::new(&[source, clip], grid).unwrap();
    let direct = c
        .overlay(0, 1, BooleanOp2D::Intersection, ContourFillRule::NonZero)
        .unwrap();
    let classified = c
        .overlay(0, 2, BooleanOp2D::Union, ContourFillRule::NonZero)
        .unwrap();
    let clipped = c
        .overlay(
            classified,
            1,
            BooleanOp2D::Intersection,
            ContourFillRule::NonZero,
        )
        .unwrap();
    assert_eq!(c.contours(direct).unwrap(), c.contours(clipped).unwrap());
    for _ in 0..4 {
        let next = c
            .overlay(
                clipped,
                1,
                BooleanOp2D::Intersection,
                ContourFillRule::NonZero,
            )
            .unwrap();
        assert_eq!(c.contours(clipped).unwrap(), c.contours(next).unwrap());
    }
}
#[test]
fn issue_4458_distinct_original_endpoints_still_refuse_before_quantization() {
    let a = vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
    let b = vec![[1e-9, 0.], [0.5, 0.2], [0.5, 0.4]];
    assert!(FixedGridComposition::new(&[vec![a, b]], 0.001).is_err());
    assert!(FixedGridComposition::new(&[vec![vec![[0., 0.]; 1025]]], 0.001).is_err());
}
#[test]
fn issue_4458_remote_infinite_line_side_change_is_not_finite_segment_topology() {
    let a = [8.2384033203125, 5.3668701171875];
    let b = [8.36767578125, 5.422167968749999];
    let c = [16., 2.4];
    let d = [20., 10.4];
    let shape = vec![a, b, [8.1, 5.6]];
    let clip = vec![c, d, [21., 2.4]];
    let mut context = FixedGridComposition::new(&[vec![shape], vec![clip]], 0.000078125).unwrap();
    let result = context
        .overlay(0, 1, BooleanOp2D::Intersection, ContourFillRule::NonZero)
        .unwrap();
    assert_eq!(context.contours(result).unwrap().shape_count(), 0);
}
#[test]
fn issue_4458_near_contact_and_incompatible_source_range_still_refuse() {
    let a = vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
    let b = vec![[1.000001, 0.2], [2., 0.2], [2., 0.8], [1.000001, 0.8]];
    assert!(FixedGridComposition::new(&[vec![a], vec![b]], 0.001).is_err());
    assert!(
        FixedGridComposition::new(&[vec![vec![[f64::NAN, 0.], [1., 0.], [0., 1.]]]], 0.001)
            .is_err()
    );
    assert!(
        FixedGridComposition::new(&[vec![vec![[0., 0.], [1e8, 0.], [0., 1e8]]]], 1e-12).is_err()
    );
}

#[test]
fn issue_4458_single_overlay_retains_empty_and_identity_semantics() {
    let ring = vec![[0., 0.], [2., 0.], [2., 2.], [0., 2.]];
    let shape = vec![ring];
    for op in [
        BooleanOp2D::Union,
        BooleanOp2D::Intersection,
        BooleanOp2D::Difference,
    ] {
        let empty =
            crate::boolean_2d_fixed_grid(&[], &[], op, ContourFillRule::NonZero, 0.001).unwrap();
        assert_eq!(empty.shape_count(), 0);
        for (subject, clip, expected) in [
            (
                shape.as_slice(),
                &[][..],
                !matches!(op, BooleanOp2D::Intersection),
            ),
            (&[][..], shape.as_slice(), matches!(op, BooleanOp2D::Union)),
        ] {
            let result =
                crate::boolean_2d_fixed_grid(subject, clip, op, ContourFillRule::NonZero, 0.001)
                    .unwrap();
            assert_eq!(result.shape_count(), usize::from(expected));
            if expected {
                assert_eq!(result.bounds(), Some([0., 0., 2., 2.]));
            }
        }
    }
    let context = FixedGridComposition::new(&[], 0.001).unwrap();
    assert_eq!(context.vertex_count(0).unwrap(), 0);
    assert!(context.vertex_count(1).is_err());
    let context = FixedGridComposition::new(&[shape], 0.001).unwrap();
    assert!(context.contours(0).is_err());
}
