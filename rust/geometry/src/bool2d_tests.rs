// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (2D boolean profile operations). Split into a
//! `*_tests.rs` file (module-size-ratchet exempt) and attached via `#[path]`.

use super::*;

#[test]
fn test_compute_signed_area_ccw() {
    // Counter-clockwise square
    let contour = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    let area = compute_signed_area(&contour);
    assert!((area - 1.0).abs() < EPSILON_2D);
}

#[test]
fn test_compute_signed_area_cw() {
    // Clockwise square
    let contour = vec![
        Point2::new(0.0, 0.0),
        Point2::new(0.0, 1.0),
        Point2::new(1.0, 1.0),
        Point2::new(1.0, 0.0),
    ];
    let area = compute_signed_area(&contour);
    assert!((area + 1.0).abs() < EPSILON_2D);
}

#[test]
fn test_ensure_ccw() {
    // Clockwise square
    let cw = vec![
        Point2::new(0.0, 0.0),
        Point2::new(0.0, 1.0),
        Point2::new(1.0, 1.0),
        Point2::new(1.0, 0.0),
    ];
    let ccw = ensure_ccw(&cw);
    assert!(compute_signed_area(&ccw) > 0.0);
}

#[test]
fn test_subtract_2d_simple() {
    // 10x10 square profile
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ]);

    // 2x2 square void in the center
    let void_contour = vec![
        Point2::new(4.0, 4.0),
        Point2::new(6.0, 4.0),
        Point2::new(6.0, 6.0),
        Point2::new(4.0, 6.0),
    ];

    let result = subtract_2d(&profile, &void_contour).unwrap();

    // Should have one hole
    assert_eq!(result.holes.len(), 1);

    // Outer boundary should be preserved
    assert_eq!(result.outer.len(), 4);
}

#[test]
fn test_subtract_multiple_2d() {
    // 10x10 square profile
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ]);

    // Two 1x1 voids
    let voids = vec![
        vec![
            Point2::new(2.0, 2.0),
            Point2::new(3.0, 2.0),
            Point2::new(3.0, 3.0),
            Point2::new(2.0, 3.0),
        ],
        vec![
            Point2::new(7.0, 7.0),
            Point2::new(8.0, 7.0),
            Point2::new(8.0, 8.0),
            Point2::new(7.0, 8.0),
        ],
    ];

    let result = subtract_multiple_2d(&profile, &voids).unwrap();

    // Should have two holes
    assert_eq!(result.holes.len(), 2);
}

#[test]
fn test_subtract_counted_interior_single_shape() {
    // Two interior voids in a 10×10 plate → ONE connected shape, two holes.
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ]);
    let voids = vec![
        vec![
            Point2::new(2.0, 2.0),
            Point2::new(3.0, 2.0),
            Point2::new(3.0, 3.0),
            Point2::new(2.0, 3.0),
        ],
        vec![
            Point2::new(7.0, 7.0),
            Point2::new(8.0, 7.0),
            Point2::new(8.0, 8.0),
            Point2::new(7.0, 8.0),
        ],
    ];
    let (res, shapes) = subtract_multiple_2d_counted(&profile, &voids).unwrap();
    assert_eq!(shapes, 1, "interior voids keep one connected shape");
    assert_eq!(res.holes.len(), 2);
}

#[test]
fn test_subtract_counted_splitting_void_multi_shape() {
    // A void that spans the full width splits the plate into TWO pieces — the
    // 2D re-extrude can't represent that, so the caller must see shapes > 1.
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ]);
    let slot = vec![
        Point2::new(-1.0, 4.5),
        Point2::new(11.0, 4.5),
        Point2::new(11.0, 5.5),
        Point2::new(-1.0, 5.5),
    ];
    let (_res, shapes) = subtract_multiple_2d_counted(&profile, &[slot]).unwrap();
    assert_eq!(
        shapes, 2,
        "a full-width slot splits the profile into two shapes"
    );
}

#[test]
fn test_point_in_contour() {
    let contour = vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ];

    assert!(point_in_contour(&Point2::new(5.0, 5.0), &contour));
    assert!(!point_in_contour(&Point2::new(15.0, 5.0), &contour));
    assert!(!point_in_contour(&Point2::new(-1.0, 5.0), &contour));
}

#[test]
fn test_is_valid_contour() {
    // Valid square
    let valid = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    assert!(is_valid_contour(&valid));

    // Degenerate (all points collinear)
    let degenerate = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(2.0, 0.0),
    ];
    assert!(!is_valid_contour(&degenerate));

    // Too few points
    let too_few = vec![Point2::new(0.0, 0.0), Point2::new(1.0, 0.0)];
    assert!(!is_valid_contour(&too_few));
}
