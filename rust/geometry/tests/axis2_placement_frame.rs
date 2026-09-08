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
//! The crate is NOT blind to that mutation. At FULL crate scope six existing
//! tests also fail:
//!
//!   processors::tests::test_polygonal_bounded_half_space_respects_boundary
//!   tests/voids_inline_matrix_test.rs        inline_void_matrix
//!   tests/rect_param_gate.rs                 param_fast_path_fires_watertight...
//!   tests/issue_1167_rotated_wall_opening.rs rotated_wall_opening_is_not_overcut
//!   tests/issue_1167_rotated_wall_opening.rs rotated_opening_cuts_clean_at_every_angle
//!   tests/issue_1167_real_wall.rs            rotated_wall_openings_not_overcut_or_fragmented
//!
//! An earlier version of this header said "the one test that does catch it".
//! That was measured with `cargo test --lib`, which excludes `tests/` -- the
//! directory this file is in. Five of the six were invisible to the scope the
//! claim was made at.
//!
//! Every one of them is downstream of a boolean or a cut volume, so each fails
//! with something like "the clipped strip should be removed" and points at a
//! CSG result rather than at a placement. This is the only test that reads the
//! translation column directly, which is the reason to keep it -- not scarcity.
//!
//! This lives in `tests/` rather than beside them because the test body would
//! push `transform.rs` (513 lines) past its 525-line ratchet budget.

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
