// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcAxis2Placement3D` with BOTH a non-identity rotation and a non-zero
//! Location — the one combination `transform.rs`'s own unit tests never make.
//!
//! `parse_axis2_placement_3d_defaults_missing_axis_and_ref_direction` is at
//! `(10, 20, 30)` with the identity rotation, and the three orthogonalization
//! tests (`..._defaults_ref_direction_when_only_axis_given`,
//! `..._orthogonalizes_parallel_ref_direction_low_z` / `..._high_z`) all place
//! the origin at `(0, 0, 0)`. Under either, the classic
//! "the translation column got rotated too" mutation —
//! `transform[(_, 3)] = R * location` instead of `location` — is the identity:
//! `R·t == t` when `R` is the identity, and `R·0 == 0` for any `R`.
//!
//! Verified by mutation: rotating the translation column in
//! `build_axis2_matrix` leaves all four of those unit tests green, while the
//! test below fails.
//!
//! The crate is NOT completely blind to that mutation, and it is worth naming
//! the one test that does catch it rather than hiding it behind a count.
//! `processors::tests::test_polygonal_bounded_half_space_respects_boundary`
//! fails too: its placement is Location `(0,0,5)` with Axis `(0,1,0)`, so
//! `R * location` is `(0,5,0)` and the clip plane moves off the top face.
//!
//! It is not a substitute for this test. It reaches `build_axis2_matrix`
//! through `processors/helpers.rs`'s own attribute-extraction fork, one of
//! five sharing that matrix builder, and asserts a downstream boolean-clipping
//! outcome -- so it fails with "the clipped strip should be removed", which
//! points at a boolean, not at a placement. This test pins `transform.rs`'s
//! own fork and reads the translation column directly.
//!
//! This lives in `tests/` rather than beside them because `transform.rs` is at
//! its module-size ratchet budget.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::parse_axis2_placement_3d;

#[test]
fn a_rotated_placement_does_not_rotate_its_own_location() {
    // Axis = (0,0,1) with RefDirection = (0,1,0) is a +90 degree turn about Z,
    // so local X maps to world +Y and local Y to world -X. Under `R * location`
    // the translation column would read (-20, 10, 30) instead of (10, 20, 30).
    let content = "\
#1=IFCCARTESIANPOINT((10.0,20.0,30.0));
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCDIRECTION((0.0,1.0,0.0));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);";
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(4).unwrap();

    let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();

    // Sanity: the rotation really is non-trivial (local X -> world +Y) ...
    assert!((m[(0, 0)] - 0.0).abs() < 1e-9, "m00 {}", m[(0, 0)]);
    assert!((m[(1, 0)] - 1.0).abs() < 1e-9, "m10 {}", m[(1, 0)]);
    // ... and Y = Z x X = (0,0,1) x (0,1,0) = (-1,0,0).
    assert!((m[(0, 1)] + 1.0).abs() < 1e-9, "m01 {}", m[(0, 1)]);
    assert!((m[(1, 1)] - 0.0).abs() < 1e-9, "m11 {}", m[(1, 1)]);

    // A placement is [R | t], not [R | R·t]: Location is already expressed in
    // the parent frame, so the rotation must not touch it.
    assert!((m[(0, 3)] - 10.0).abs() < 1e-9, "tx {}", m[(0, 3)]);
    assert!((m[(1, 3)] - 20.0).abs() < 1e-9, "ty {}", m[(1, 3)]);
    assert!((m[(2, 3)] - 30.0).abs() < 1e-9, "tz {}", m[(2, 3)]);
}
