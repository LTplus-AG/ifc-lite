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
fn test_subtract_counted_subthreshold_sliver_still_multi_shape() {
    // Data-integrity regression: a void that splits the profile into a big piece
    // plus a TINY disconnected sliver whose signed area is at/below
    // MIN_AREA_THRESHOLD must STILL report shapes > 1, so the caller defers to the
    // exact kernel instead of silently dropping the sliver via largest-shape keep.
    //
    // Small coordinate scale (0.02) so i_overlay's grid preserves the sliver as a
    // distinct output shape while its area stays below MIN_AREA_THRESHOLD (a
    // full-width band split at scale 10 either drops the sliver entirely or leaves
    // one whose area is orders of magnitude above the threshold).
    let scale = 0.02_f64;
    let profile = Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(scale, 0.0),
        Point2::new(scale, scale),
        Point2::new(0.0, scale),
    ]);
    // Full-width band that leaves a `scale * 1e-8`-thick sliver along the top edge.
    let top_h = scale * 1e-8;
    let b_lo = scale * 0.45;
    let b_hi = scale - top_h;
    let band = vec![
        Point2::new(-scale, b_lo),
        Point2::new(scale * 2.0, b_lo),
        Point2::new(scale * 2.0, b_hi),
        Point2::new(-scale, b_hi),
    ];

    let (_res, shapes) =
        subtract_multiple_2d_counted(&profile, std::slice::from_ref(&band)).unwrap();
    assert_eq!(
        shapes, 2,
        "a sub-threshold sliver must still be counted, forcing the exact-kernel defer"
    );

    // Confirm the split really produces a sub-threshold shape (i.e. this exercises
    // the area-filter blind spot, not merely two above-threshold pieces): the
    // smaller output shape's area is at/below MIN_AREA_THRESHOLD, so the old
    // `area > MIN_AREA_THRESHOLD` count would have undercounted it to shapes == 1.
    let subject = profile_to_paths(&profile);
    let clip = vec![contour_to_path(&band)];
    let result = subject.overlay(&clip, OverlayRule::Difference, FillRule::EvenOdd);
    let mut areas: Vec<f64> = result
        .iter()
        .filter_map(|s| {
            s.first().map(|o| {
                let ring: Vec<Point2<f64>> = o.iter().map(|p| Point2::new(p[0], p[1])).collect();
                compute_signed_area(&ring).abs()
            })
        })
        .collect();
    areas.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(areas.len(), 2, "the split yields exactly two output shapes");
    assert!(
        areas[0] <= MIN_AREA_THRESHOLD,
        "smaller shape area {} must be <= MIN_AREA_THRESHOLD {} (the blind spot the fix closes)",
        areas[0],
        MIN_AREA_THRESHOLD
    );
    let above_threshold = areas
        .iter()
        .filter(|a| **a > MIN_AREA_THRESHOLD)
        .count();
    assert_eq!(
        above_threshold, 1,
        "old area-filtered count would have seen only 1 shape and proceeded"
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
