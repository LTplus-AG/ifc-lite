// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native (non-wasm) tests for the space-plate wire arithmetic extracted from
//! behind the `JsValue` boundary: `build_segments` (stride 4, `o+2`/`o+3`
//! pairing, `-1` source sentinel, `half.max(0.0)`), `build_wall_rects`
//! (stride 8 -> four corners) and `edit_error_parts` (the cross-language
//! `EditError` -> stable-code contract `space-edit-error.ts` switches on).

use super::{build_segments, build_wall_rects, edit_error_parts, resolve_build_options};
use ifc_lite_geometry::space_dcel::EditError;

// ---- resolve_build_options -----------------------------------------------

#[test]
fn resolve_build_options_uses_defaults_at_and_below_zero() {
    let default_opts = resolve_build_options(0.0, 0.0);
    assert_eq!(default_opts.snap_tolerance, 0.1);
    assert_eq!(default_opts.min_area, 0.5);
    // Negative values also fall back (a hostile / uninitialised wire value),
    // not just exactly zero -- but zero is the boundary the "<= 0" guard
    // exists for, so it is asserted separately below.
    let negative = resolve_build_options(-1.0, -2.0);
    assert_eq!(negative.snap_tolerance, 0.1);
    assert_eq!(negative.min_area, 0.5);
}

#[test]
fn resolve_build_options_passes_through_positive_values() {
    let opts = resolve_build_options(0.25, 1.5);
    assert_eq!(opts.snap_tolerance, 0.25);
    assert_eq!(opts.min_area, 1.5);
}

// ---- build_segments -------------------------------------------------------

/// Two segments with distinct, non-repeating coordinates so a stride error
/// (reading the wrong 4-window) or a swapped a/b pairing is observable.
fn two_segments_wire() -> (Vec<f64>, Vec<i32>, Vec<f64>) {
    let coords = vec![
        0.0, 1.0, 2.0, 3.0, // segment 0: a=(0,1) b=(2,3)
        10.0, 11.0, 12.0, 13.0, // segment 1: a=(10,11) b=(12,13)
    ];
    let sources = vec![-1, 42];
    let half_thickness = vec![0.2, 0.3];
    (coords, sources, half_thickness)
}

#[test]
fn build_segments_slices_stride_4_with_correct_a_b_pairing() {
    let (coords, sources, half) = two_segments_wire();
    let segs = build_segments(&coords, &sources, &half).expect("valid wire must parse");
    assert_eq!(segs.len(), 2);
    assert_eq!(segs[0].a, [0.0, 1.0]);
    assert_eq!(segs[0].b, [2.0, 3.0]);
    assert_eq!(segs[1].a, [10.0, 11.0]);
    assert_eq!(segs[1].b, [12.0, 13.0]);
}

#[test]
fn build_segments_maps_negative_source_to_none_and_others_to_some() {
    let (coords, sources, half) = two_segments_wire();
    let segs = build_segments(&coords, &sources, &half).unwrap();
    assert_eq!(segs[0].source_element, None); // -1 sentinel
    assert_eq!(segs[1].source_element, Some(42));
}

#[test]
fn build_segments_floors_negative_half_thickness_at_zero() {
    let (coords, sources, _half) = two_segments_wire();
    let half = vec![-5.0, 0.3];
    let segs = build_segments(&coords, &sources, &half).unwrap();
    assert_eq!(segs[0].half_thickness, 0.0, "a negative wire value must floor to 0.0, not pass through negative");
    assert_eq!(segs[1].half_thickness, 0.3);
}

#[test]
fn build_segments_defaults_half_thickness_to_zero_when_array_empty() {
    let (coords, sources, _half) = two_segments_wire();
    let segs = build_segments(&coords, &sources, &[]).unwrap();
    assert_eq!(segs[0].half_thickness, 0.0);
    assert_eq!(segs[1].half_thickness, 0.0);
}

#[test]
fn build_segments_rejects_coords_len_not_a_multiple_of_4() {
    let coords = vec![0.0, 1.0, 2.0]; // 3, not a multiple of 4
    let err = build_segments(&coords, &[], &[]).unwrap_err();
    assert_eq!(err, "segCoords length must be a multiple of 4 (ax, ay, bx, by per segment)");
}

#[test]
fn build_segments_rejects_sources_length_mismatch() {
    let (coords, _sources, half) = two_segments_wire();
    let wrong_sources = vec![-1]; // 1 entry, but coords implies 2 segments
    let err = build_segments(&coords, &wrong_sources, &half).unwrap_err();
    assert_eq!(err, "segSources length must equal the segment count (segCoords.len / 4)");
}

#[test]
fn build_segments_rejects_half_thickness_length_mismatch() {
    let (coords, sources, _half) = two_segments_wire();
    let wrong_half = vec![0.2]; // 1 entry, not 0 (empty) or 2
    let err = build_segments(&coords, &sources, &wrong_half).unwrap_err();
    assert_eq!(err, "segHalfThickness must be empty or have one entry per segment");
}

#[test]
fn build_segments_rejects_too_many_segments() {
    // One coord-quadruple over the MAX_INPUT_SEGMENTS ceiling (16384).
    let n = 16385;
    let coords: Vec<f64> = (0..n * 4).map(|i| i as f64).collect();
    let sources = vec![-1i32; n];
    let err = build_segments(&coords, &sources, &[]).unwrap_err();
    assert_eq!(err, "too many wall segments for the space-plate arrangement");
}

// ---- build_wall_rects -------------------------------------------------------

#[test]
fn build_wall_rects_slices_stride_8_into_four_ccw_corners() {
    // Two walls with distinct, non-repeating coordinates.
    let coords = vec![
        0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, // wall 0
        5.0, 5.0, 6.0, 5.0, 6.0, 6.0, 5.0, 6.0, // wall 1
    ];
    let rects = build_wall_rects(&coords).expect("valid wire must parse");
    assert_eq!(rects.len(), 2);
    assert_eq!(rects[0], [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
    assert_eq!(rects[1], [[5.0, 5.0], [6.0, 5.0], [6.0, 6.0], [5.0, 6.0]]);
}

#[test]
fn build_wall_rects_rejects_len_not_a_multiple_of_8() {
    let coords = vec![0.0; 9]; // one short of two full walls
    let err = build_wall_rects(&coords).unwrap_err();
    assert_eq!(err, "rectCoords length must be a multiple of 8 (4 corners × x,y per wall)");
}

#[test]
fn build_wall_rects_rejects_too_many_rects() {
    let n = 4097; // one over MAX_INPUT_RECTS (4096)
    let coords: Vec<f64> = vec![0.0; n * 8];
    let err = build_wall_rects(&coords).unwrap_err();
    assert_eq!(err, "too many wall rects for the space-plate arrangement");
}

#[test]
fn build_segments_accepts_exactly_the_segment_ceiling() {
    // The reject test above walks one OVER the ceiling. Nothing walked the
    // accept side, so changing `n > MAX` to `n >= MAX` -- which starts
    // rejecting a legal 16384-segment input -- kept the suite green. A ceiling
    // has two sides and only one of them was exercised.
    let n = 16384;
    let coords: Vec<f64> = (0..n * 4).map(|i| i as f64).collect();
    let sources = vec![-1i32; n];
    let segs = build_segments(&coords, &sources, &[]).expect("exactly the ceiling must be accepted");
    assert_eq!(segs.len(), n);
}

#[test]
fn build_wall_rects_accepts_exactly_the_rect_ceiling() {
    // Same missing side as the segment ceiling above: `> MAX` -> `>= MAX`
    // rejects a legal 4096-rect input and no test noticed.
    let n = 4096;
    let coords: Vec<f64> = vec![0.0; n * 8];
    let rects = build_wall_rects(&coords).expect("exactly the ceiling must be accepted");
    assert_eq!(rects.len(), n);
}

// ---- edit_error_parts: the cross-language contract with space-edit-error.ts

/// Every `EditError` variant, paired with the EXACT `EditErrorCode` string
/// `apps/viewer/src/lib/space-edit-error.ts` lists in its `CODES` set. A
/// variant added on one side with no counterpart on the other is the finding
/// this test exists to catch -- so the list here is also the audit: every
/// arm below must appear verbatim in that TS file's `CODES` set for the
/// contract to hold. Verified by reading `space-edit-error.ts` on
/// 2026-08-24: all seven match exactly, no extra codes either side.
const EXPECTED_CODES: &[(EditError, &str)] = &[
    (EditError::StaleHandle, "StaleHandle"),
    (EditError::VerticesNotOnFace, "VerticesNotOnFace"),
    (EditError::DegenerateCut, "DegenerateCut"),
    (EditError::BordersExterior, "BordersExterior"),
    (EditError::BridgeEdge, "BridgeEdge"),
    (EditError::VertexNotDissolvable, "VertexNotDissolvable"),
    (EditError::InvalidPolygon, "InvalidPolygon"),
];

#[test]
fn edit_error_parts_codes_match_the_ts_contract_variant_by_variant() {
    for (variant, expected_code) in EXPECTED_CODES {
        let (code, _msg) = edit_error_parts(variant.clone());
        assert_eq!(code, *expected_code, "code for {variant:?} must match space-edit-error.ts's CODES set");
    }
}

#[test]
fn edit_error_parts_messages_are_non_empty_and_distinct_per_variant() {
    let mut seen = std::collections::HashSet::new();
    for (variant, _code) in EXPECTED_CODES {
        let (_code, msg) = edit_error_parts(variant.clone());
        assert!(!msg.is_empty());
        assert!(seen.insert(msg), "message for {variant:?} duplicates another variant's message: {msg:?}");
    }
}

#[test]
fn edit_error_parts_covers_exactly_seven_variants_no_more_no_less() {
    // Production's `edit_error_parts` already matches all seven variants with
    // no wildcard, so an eighth variant fails the build there first -- this
    // match does NOT add that alarm. What it adds is the case where someone
    // silences that build failure by giving `edit_error_parts` a `_ =>` arm:
    // production would compile again, and this match would not.
    fn assert_exhaustive(e: EditError) -> &'static str {
        match e {
            EditError::StaleHandle
            | EditError::VerticesNotOnFace
            | EditError::DegenerateCut
            | EditError::BordersExterior
            | EditError::BridgeEdge
            | EditError::VertexNotDissolvable
            | EditError::InvalidPolygon => "covered",
        }
    }
    assert_eq!(assert_exhaustive(EditError::StaleHandle), "covered");

    // The `assert_eq!` above is self-referential -- `assert_exhaustive` can only
    // return the literal it is compared to -- and is kept solely so the function
    // is not dead code. The compile-time `match` is the whole point of it.
    //
    // The COUNT below is what carries this test's name. `EXPECTED_CODES` is the
    // oracle for the TS contract, and deleting a row from it used to be caught
    // by `assert_eq!(EXPECTED_CODES.len(), 7)`; without a count, a silently
    // shrunk table leaves every test green, including this one. Measured: drop
    // the `BridgeEdge` row and the suite passes 127/127 with no count here.
    //
    // Distinctness is asserted alongside it, but be clear that it is belt and
    // braces rather than new power: `edit_error_parts_codes_match_the_ts_contract_variant_by_variant`
    // already pins every code to a distinct literal, so if that test passes this
    // insert cannot fail. It earns its place only by making the failure explicit
    // if that sibling is ever weakened.
    let mut seen = std::collections::HashSet::new();
    for (variant, _code) in EXPECTED_CODES {
        let (code, _msg) = edit_error_parts(variant.clone());
        assert!(seen.insert(code), "code for {variant:?} duplicates another variant's code: {code:?}");
    }
    assert_eq!(seen.len(), 7, "EXPECTED_CODES must carry exactly the seven EditError variants");
}
