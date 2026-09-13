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
    //
    // NOTE, and this is a known weakness left in place deliberately: re-running the
    // SAME overlay call the production function ran only measures i_overlay against
    // itself, so it can say nothing about whether the difference is correct. Its one
    // job here is to size the two output shapes so the threshold claim above is not
    // asserted blind. It mirrors production's operands (`ccw_paths` + NonZero)
    // so it keeps measuring the shapes production actually produced.
    let subject = profile_to_paths(&profile);
    let clip = ccw_paths([band.as_slice()]);
    let result = subject.overlay(&clip, OverlayRule::Difference, FillRule::NonZero);
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

/// Net material area of a profile: outer minus every hole.
fn net_area(p: &Profile2D) -> f64 {
    compute_signed_area(&p.outer).abs()
        - p.holes
            .iter()
            .map(|h| compute_signed_area(h).abs())
            .sum::<f64>()
}

/// Two rectangles, `[2,6]^2` and `[4,8]^2`, OVERLAPPING on `[4,6]^2`.
/// Union area 16 + 16 - 4 = 28; symmetric difference 24.
fn overlapping_void_pair() -> Vec<Vec<Point2<f64>>> {
    vec![
        vec![
            Point2::new(2.0, 2.0),
            Point2::new(6.0, 2.0),
            Point2::new(6.0, 6.0),
            Point2::new(2.0, 6.0),
        ],
        vec![
            Point2::new(4.0, 4.0),
            Point2::new(8.0, 4.0),
            Point2::new(8.0, 8.0),
            Point2::new(4.0, 8.0),
        ],
    ]
}

fn plate_10x10() -> Profile2D {
    Profile2D::new(vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ])
}

/// The three overlap tests share one expected shape: the two `[2,6]^2` and
/// `[4,8]^2` footprints (union 28, overlap 4) leave ONE hole of the UNION's
/// area in a 10x10 plate, so net material is 72. The wrong answers each test
/// guards against: a hole of 24 is the symmetric difference (the overlap XOR'd
/// back out), and net 76 is the phantom pillar that leaves between the
/// openings.
fn assert_single_merged_hole(result: &Profile2D, case: &str) {
    assert_eq!(result.holes.len(), 1, "{case}: the two footprints merge into ONE hole");
    let hole_area = compute_signed_area(&result.holes[0]).abs();
    assert!(
        (hole_area - 28.0).abs() < 1e-6,
        "{case}: merged hole must be the UNION (28.0), got {hole_area} (24.0 = symmetric difference)"
    );
    let net = net_area(result);
    assert!(
        (net - 72.0).abs() < 1e-6,
        "{case}: net material must be 100 - 28 = 72.0, got {net} (76.0 = the phantom pillar)"
    );
}

/// Regression for #4579.
#[test]
fn overlapping_voids_merge_instead_of_cancelling() {
    // Regression: under `FillRule::EvenOdd` i_overlay applies the rule to the CLIP
    // operand too, so the `[4,6]^2` patch covered by BOTH clip rings has winding 2
    // and `1 & 2 == 0` -- it is NOT removed. The difference then subtracts the
    // SYMMETRIC DIFFERENCE (24) instead of the union (28), leaving a phantom 2x2
    // pillar of material between the two openings: net 76.00, not 72.00.
    let profile = plate_10x10();
    let voids = overlapping_void_pair();

    let result = subtract_multiple_2d(&profile, &voids).unwrap();
    assert_single_merged_hole(&result, "two CCW footprints");

    // The counted variant feeds the production re-extrude gate: still ONE shape.
    let (counted, shapes) = subtract_multiple_2d_counted(&profile, &voids).unwrap();
    assert_eq!(
        shapes, 1,
        "overlapping interior voids keep one connected shape"
    );
    assert!((net_area(&counted) - 72.0).abs() < 1e-6);
}

/// Regression for #4579.
#[test]
fn overlapping_voids_merge_when_one_footprint_is_mirrored() {
    // `NonZero` alone is not enough: a CW (mirrored / negatively scaled) footprint
    // contributes winding -1, so the `[4,6]^2` overlap sums to 0 and survives as
    // material exactly as it did under EvenOdd. Each clip contour must be
    // normalised CCW first. Same numbers as above: union 28, net 72.
    let profile = plate_10x10();
    let mut voids = overlapping_void_pair();
    voids[1].reverse(); // author the second opening clockwise
    assert!(
        compute_signed_area(&voids[1]) < 0.0,
        "fixture precondition: the second footprint really is CW"
    );

    let result = subtract_multiple_2d(&profile, &voids).unwrap();
    assert_single_merged_hole(&result, "one footprint mirrored CW");
}

/// Regression for #4610; remove with #4617's mixed-route compatibility helper.
#[test]
fn mixed_route_compat_preserves_established_overlap_parity() {
    let profile = plate_10x10();
    let voids = overlapping_void_pair();
    let (result, shapes) =
        subtract_multiple_2d_counted_mixed_compat(&profile, &voids).unwrap();
    assert_eq!(shapes, 1);
    assert!(
        (net_area(&result) - 76.0).abs() < 1e-6,
        "mixed routing keeps its established input mesh until #4617"
    );
}

/// Regression for #4579.
#[test]
fn subtract_2d_single_void_overlapping_an_existing_hole_merges() {
    // Single-clip path (`subtract_2d`): the host already has a `[2,6]^2` hole and
    // the new void `[4,8]^2` overlaps it. The SUBJECT side carries that existing
    // hole as a CW ring, which is exactly the NonZero contract `profile_to_paths`
    // already emits -- so switching the rule must not resurrect it. Union 28, net 72.
    let mut profile = plate_10x10();
    profile.holes.push(ensure_cw(&overlapping_void_pair()[0]));
    assert!((net_area(&profile) - 84.0).abs() < 1e-6);

    let result = subtract_2d(&profile, &overlapping_void_pair()[1]).unwrap();
    assert_single_merged_hole(&result, "void over an existing hole");
}
