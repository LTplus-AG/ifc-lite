// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (general contour-set 2D booleans, issue #1863).
//! Split into a `*_tests.rs` file (module-size-ratchet exempt) and attached via
//! `#[path]`.

use super::*;
use crate::projection_outline::{mesh_outline_2d, ProjectionAxis};

/// Axis-aligned rectangle, counter-clockwise (positive area = covered region).
fn rect_ccw(x0: f64, y0: f64, x1: f64, y1: f64) -> Ring2D {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/// Axis-aligned rectangle, clockwise (negative area = hole under NonZero).
fn rect_cw(x0: f64, y0: f64, x1: f64, y1: f64) -> Ring2D {
    vec![[x0, y0], [x0, y1], [x1, y1], [x1, y0]]
}

fn signed_area(ring: &Ring2D) -> f64 {
    let n = ring.len();
    let mut a = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    }
    a * 0.5
}

/// Total covered area: outer rings add, hole rings subtract, which is exactly
/// what summing the signed areas does when winding carries outer-vs-hole.
fn covered_area(set: &ContourSet) -> f64 {
    set.rings.iter().map(signed_area).sum()
}

const TOL: f64 = 1e-9;

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

#[test]
fn union_of_overlapping_squares_merges_into_one_shape() {
    let a = vec![rect_ccw(0.0, 0.0, 2.0, 2.0)];
    let b = vec![rect_ccw(1.0, 1.0, 3.0, 3.0)];
    let out = boolean_2d(&a, &b, BooleanOp2D::Union);
    assert_eq!(out.shape_count(), 1, "overlapping squares are one region");
    assert_eq!(out.rings.len(), 1, "an L-shape has no holes");
    // 4 + 4 - 1 overlap.
    assert!((covered_area(&out) - 7.0).abs() < TOL, "{}", covered_area(&out));
}

#[test]
fn union_of_disjoint_squares_keeps_both_shapes() {
    let a = vec![rect_ccw(0.0, 0.0, 1.0, 1.0)];
    let b = vec![rect_ccw(5.0, 5.0, 6.0, 6.0)];
    let out = boolean_2d(&a, &b, BooleanOp2D::Union);
    assert_eq!(out.shape_count(), 2, "disjoint islands must both survive");
    assert_eq!(out.shape_offsets, vec![0, 1]);
    assert!((covered_area(&out) - 2.0).abs() < TOL);
}

#[test]
fn union_closing_a_ring_leaves_a_hole() {
    // Four bars forming a square annulus: the enclosed middle is a hole.
    let bars = vec![
        rect_ccw(0.0, 0.0, 10.0, 1.0),
        rect_ccw(0.0, 9.0, 10.0, 10.0),
        rect_ccw(0.0, 0.0, 1.0, 10.0),
        rect_ccw(9.0, 0.0, 10.0, 10.0),
    ];
    let out = resolve_2d(&bars);
    assert_eq!(out.shape_count(), 1);
    assert_eq!(out.rings.len(), 2, "outer boundary + one hole");
    let shape = out.shape(0).expect("shape 0");
    assert!(signed_area(&shape[0]) > 0.0, "outer ring must be CCW");
    assert!(signed_area(&shape[1]) < 0.0, "hole ring must be CW");
    // 100 total minus the 8x8 middle.
    assert!((covered_area(&out) - 36.0).abs() < TOL, "{}", covered_area(&out));
}

// ---------------------------------------------------------------------------
// Difference — the case the Profile2D-shaped `subtract_2d` cannot express
// ---------------------------------------------------------------------------

#[test]
fn difference_splitting_the_subject_keeps_every_island() {
    // A wide bar cut by a vertical strip through its middle: two visible
    // slivers. `subtract_2d` would return only the larger one.
    let bar = vec![rect_ccw(0.0, 0.0, 10.0, 1.0)];
    let cutter = vec![rect_ccw(4.0, -1.0, 6.0, 2.0)];
    let out = boolean_2d(&bar, &cutter, BooleanOp2D::Difference);
    assert_eq!(out.shape_count(), 2, "both remnants must survive the cut");
    assert!((covered_area(&out) - 8.0).abs() < TOL, "{}", covered_area(&out));
}

#[test]
fn difference_into_the_interior_makes_a_hole() {
    let outer = vec![rect_ccw(0.0, 0.0, 10.0, 10.0)];
    let inner = vec![rect_ccw(4.0, 4.0, 6.0, 6.0)];
    let out = boolean_2d(&outer, &inner, BooleanOp2D::Difference);
    assert_eq!(out.shape_count(), 1);
    assert_eq!(out.rings.len(), 2, "outer boundary + punched hole");
    assert!(signed_area(&out.rings[1]) < 0.0, "punched hole must be CW");
    assert!((covered_area(&out) - 96.0).abs() < TOL);
}

#[test]
fn difference_covering_the_subject_is_empty() {
    let a = vec![rect_ccw(1.0, 1.0, 2.0, 2.0)];
    let b = vec![rect_ccw(0.0, 0.0, 10.0, 10.0)];
    let out = boolean_2d(&a, &b, BooleanOp2D::Difference);
    assert!(out.is_empty(), "a fully occluded element contributes nothing");
    assert_eq!(out.shape_count(), 0);
}

#[test]
fn difference_against_many_clip_rings_subtracts_their_union() {
    // A caller does not need a `differenceMultiple2d`: several subtrahends in
    // one clip set union implicitly under NonZero, including where they overlap.
    let bar = vec![rect_ccw(0.0, 0.0, 10.0, 1.0)];
    let cutters = vec![
        rect_ccw(2.0, -1.0, 4.0, 2.0),
        rect_ccw(3.0, -1.0, 5.0, 2.0), // overlaps the previous one
        rect_ccw(8.0, -1.0, 9.0, 2.0),
    ];
    let out = boolean_2d(&bar, &cutters, BooleanOp2D::Difference);
    // Removed: x in [2,5] (3 wide, the overlap counted once) and [8,9] (1 wide).
    assert!((covered_area(&out) - 6.0).abs() < TOL, "{}", covered_area(&out));
    assert_eq!(out.shape_count(), 3, "remnants at [0,2], [5,8] and [9,10]");
}

// ---------------------------------------------------------------------------
// Intersection
// ---------------------------------------------------------------------------

#[test]
fn intersection_is_the_shared_region() {
    let a = vec![rect_ccw(0.0, 0.0, 2.0, 2.0)];
    let b = vec![rect_ccw(1.0, 1.0, 3.0, 3.0)];
    let out = boolean_2d(&a, &b, BooleanOp2D::Intersection);
    assert_eq!(out.shape_count(), 1);
    assert!((covered_area(&out) - 1.0).abs() < TOL);
    let bounds = out.bounds().expect("bounds");
    assert!((bounds[0] - 1.0).abs() < TOL && (bounds[2] - 2.0).abs() < TOL);
}

#[test]
fn intersection_of_disjoint_sets_is_empty() {
    let a = vec![rect_ccw(0.0, 0.0, 1.0, 1.0)];
    let b = vec![rect_ccw(5.0, 5.0, 6.0, 6.0)];
    assert!(boolean_2d(&a, &b, BooleanOp2D::Intersection).is_empty());
}

#[test]
fn intersecting_a_tile_clips_a_holed_subject_and_keeps_the_hole() {
    // Screen tiling against a frame: the tile covers the frame's left half,
    // including part of its hole, so the hole must survive the clip.
    let frame = vec![rect_ccw(0.0, 0.0, 10.0, 10.0), rect_cw(3.0, 3.0, 7.0, 7.0)];
    let tile = vec![rect_ccw(-1.0, -1.0, 5.0, 11.0)];
    let out = boolean_2d(&frame, &tile, BooleanOp2D::Intersection);
    // Left half of the frame: 5x10 minus the 2x4 slice of hole inside the tile.
    assert!((covered_area(&out) - 42.0).abs() < TOL, "{}", covered_area(&out));
}

// ---------------------------------------------------------------------------
// Winding contract
// ---------------------------------------------------------------------------

#[test]
fn input_hole_winding_is_respected_not_normalised() {
    // The CW inner ring is a hole, so the set covers 100 - 16 = 84, and a
    // union with an unrelated island must not "repair" it into 100.
    let frame = vec![rect_ccw(0.0, 0.0, 10.0, 10.0), rect_cw(3.0, 3.0, 7.0, 7.0)];
    let island = vec![rect_ccw(20.0, 20.0, 21.0, 21.0)];
    let out = boolean_2d(&frame, &island, BooleanOp2D::Union);
    assert_eq!(out.shape_count(), 2);
    assert!((covered_area(&out) - 85.0).abs() < TOL, "{}", covered_area(&out));
}

#[test]
fn a_result_round_trips_through_another_boolean_unchanged() {
    // The output winding must be valid input winding, or an accumulating
    // occluder loop drifts after its first iteration.
    let frame = vec![rect_ccw(0.0, 0.0, 10.0, 10.0), rect_cw(3.0, 3.0, 7.0, 7.0)];
    let once = resolve_2d(&frame);
    let twice = resolve_2d(&once.rings);
    assert_eq!(once.shape_offsets, twice.shape_offsets);
    assert!((covered_area(&once) - covered_area(&twice)).abs() < TOL);
    assert!((covered_area(&twice) - 84.0).abs() < TOL);
}

#[test]
fn accumulating_an_occluder_matches_a_single_union() {
    // The hidden-surface-removal loop shape: fold elements one at a time into
    // one accumulator, and it must equal unioning them all at once.
    let elements = [
        rect_ccw(0.0, 0.0, 4.0, 4.0),
        rect_ccw(3.0, 3.0, 7.0, 7.0),
        rect_ccw(6.0, 0.0, 9.0, 9.0),
        rect_ccw(20.0, 0.0, 21.0, 1.0),
    ];
    let mut acc = ContourSet::default();
    for e in &elements {
        acc = boolean_2d(&acc.rings, std::slice::from_ref(e), BooleanOp2D::Union);
    }
    let all: Vec<Ring2D> = elements.to_vec();
    let at_once = resolve_2d(&all);
    assert_eq!(acc.shape_count(), at_once.shape_count());
    assert!((covered_area(&acc) - covered_area(&at_once)).abs() < TOL);
}

// ---------------------------------------------------------------------------
// Interop with mesh_outline_2d
// ---------------------------------------------------------------------------

#[test]
fn mesh_outline_rings_feed_straight_back_in() {
    // Two triangles forming the unit square in the z=0 plane, viewed down Z.
    let positions: Vec<f32> = vec![
        0.0, 0.0, 0.0, //
        1.0, 0.0, 0.0, //
        1.0, 1.0, 0.0, //
        0.0, 1.0, 0.0,
    ];
    let indices: Vec<u32> = vec![0, 1, 2, 0, 2, 3];
    let outline =
        mesh_outline_2d(&positions, &indices, ProjectionAxis::Z, false).expect("outline");
    let rings: Vec<Ring2D> = outline
        .contours
        .iter()
        .map(|ring| ring.iter().map(|p| [p[0] as f64, p[1] as f64]).collect())
        .collect();

    let resolved = resolve_2d(&rings);
    assert_eq!(resolved.shape_count(), 1);
    assert!(
        (covered_area(&resolved) - 1.0).abs() < 1e-6,
        "outline area must survive the round trip: {}",
        covered_area(&resolved)
    );

    // And it differences like any other subject.
    let cutter = vec![rect_ccw(0.25, -1.0, 0.75, 2.0)];
    let cut = boolean_2d(&rings, &cutter, BooleanOp2D::Difference);
    assert_eq!(cut.shape_count(), 2, "the strip splits the square in two");
    assert!((covered_area(&cut) - 0.5).abs() < 1e-6);
}

// ---------------------------------------------------------------------------
// Degenerate input never panics
// ---------------------------------------------------------------------------

#[test]
fn empty_operands_have_defined_answers() {
    let a = vec![rect_ccw(0.0, 0.0, 1.0, 1.0)];
    let none: Vec<Ring2D> = Vec::new();

    assert!((covered_area(&boolean_2d(&a, &none, BooleanOp2D::Union)) - 1.0).abs() < TOL);
    assert!((covered_area(&boolean_2d(&none, &a, BooleanOp2D::Union)) - 1.0).abs() < TOL);
    assert!((covered_area(&boolean_2d(&a, &none, BooleanOp2D::Difference)) - 1.0).abs() < TOL);
    assert!(boolean_2d(&none, &a, BooleanOp2D::Difference).is_empty());
    assert!(boolean_2d(&a, &none, BooleanOp2D::Intersection).is_empty());
    assert!(boolean_2d(&none, &a, BooleanOp2D::Intersection).is_empty());
    assert!(boolean_2d(&none, &none, BooleanOp2D::Union).is_empty());
    assert!(resolve_2d(&none).is_empty());
    assert!(resolve_2d(&none).bounds().is_none());
}

#[test]
fn undersized_and_non_finite_rings_are_dropped_not_fatal() {
    let good = rect_ccw(0.0, 0.0, 1.0, 1.0);
    let subject = vec![
        good.clone(),
        vec![[0.0, 0.0], [1.0, 0.0]],                        // 2 points
        vec![[5.0, 5.0], [f64::NAN, 6.0], [6.0, 5.0]],       // NaN
        vec![[7.0, 7.0], [f64::INFINITY, 8.0], [8.0, 7.0]],  // inf
        vec![],                                              // empty
    ];
    let out = resolve_2d(&subject);
    assert_eq!(out.shape_count(), 1, "only the valid ring survives");
    assert!((covered_area(&out) - 1.0).abs() < TOL);
}

#[test]
fn explicitly_closed_rings_are_accepted() {
    // A caller that repeats the first vertex to close the ring must get the
    // same answer as one that does not (no zero-length edge into the overlay).
    let open = rect_ccw(0.0, 0.0, 2.0, 2.0);
    let mut closed = open.clone();
    closed.push(open[0]);
    let a = resolve_2d(&[open]);
    let b = resolve_2d(&[closed]);
    assert_eq!(a.shape_count(), b.shape_count());
    assert!((covered_area(&a) - covered_area(&b)).abs() < TOL);
    assert!((covered_area(&b) - 4.0).abs() < TOL);
}

#[test]
fn a_zero_area_ring_contributes_nothing() {
    // A 3-vertex collinear ring is structurally valid (>= 3 finite vertices)
    // but covers nothing. `sanitize` must drop it, so a set built from ONLY
    // such rings is genuinely empty — its `is_empty`/`bounds` cannot then
    // disagree with what a boolean keeps.
    let collinear = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]];
    assert!(
        sanitize(std::slice::from_ref(&collinear)).is_empty(),
        "sanitize must drop a zero-area ring, not just the overlay"
    );
    let out = resolve_2d(&[collinear]);
    assert!(out.is_empty(), "a collapsed ring covers no area");
    assert!(out.bounds().is_none(), "bounds must agree with is_empty");
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

#[test]
fn shape_accessor_groups_outer_with_its_holes() {
    // One holed shape plus a plain island; the grouping must not run them
    // together (the flaw in `mesh_outline_2d`'s flattened contour list).
    let holed = vec![rect_ccw(0.0, 0.0, 10.0, 10.0), rect_cw(3.0, 3.0, 7.0, 7.0)];
    let island = vec![rect_ccw(20.0, 20.0, 21.0, 21.0)];
    let out = boolean_2d(&holed, &island, BooleanOp2D::Union);

    assert_eq!(out.shape_count(), 2);
    assert_eq!(out.rings.len(), 3);
    let mut sizes: Vec<usize> = (0..out.shape_count())
        .map(|s| out.shape(s).expect("shape").len())
        .collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![1, 2], "one plain island, one outer + hole");
    assert!(out.shape(2).is_none(), "out-of-range shape index");
}

#[test]
fn bounds_span_every_shape() {
    let a = vec![rect_ccw(-3.0, -2.0, 1.0, 1.0)];
    let b = vec![rect_ccw(5.0, 5.0, 6.0, 8.0)];
    let out = boolean_2d(&a, &b, BooleanOp2D::Union);
    let bounds = out.bounds().expect("bounds");
    assert!((bounds[0] + 3.0).abs() < TOL, "min x {}", bounds[0]);
    assert!((bounds[1] + 2.0).abs() < TOL, "min y {}", bounds[1]);
    assert!((bounds[2] - 6.0).abs() < TOL, "max x {}", bounds[2]);
    assert!((bounds[3] - 8.0).abs() < TOL, "max y {}", bounds[3]);
}

#[test]
fn op_codes_decode_and_reject() {
    assert_eq!(BooleanOp2D::from_u8(0), Some(BooleanOp2D::Union));
    assert_eq!(BooleanOp2D::from_u8(1), Some(BooleanOp2D::Difference));
    assert_eq!(BooleanOp2D::from_u8(2), Some(BooleanOp2D::Intersection));
    assert_eq!(BooleanOp2D::from_u8(3), None);
}
