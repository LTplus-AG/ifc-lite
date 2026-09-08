// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Round-26 mutation-audit fixtures for `read_rect_profile_2d`'s
//! `IfcArbitraryClosedProfileDef` (4-point polyline) path: the
//! adjacent-edge-perpendicularity tolerance (`dot.abs() > 0.01`) had never
//! been mutated because the surrounding pipeline is only exercised through
//! full-fixture integration tests. These build a minimal STEP snippet
//! (mirroring `geometry/src/profiles/tests.rs`) and call the private method
//! directly.

use super::*;
use ifc_lite_core::EntityDecoder;

/// A 4-point `IFCPOLYLINE` parallelogram: edge0 = (1,0), edge1 = (dot, y)
/// with `y = sqrt(1 - dot^2)` so `|edge1| == 1` and the normalized dot
/// product between edge0 and edge1 is exactly `dot`. p2 = p1+edge1,
/// p3 = p0+edge1 closes it as a parallelogram (opposite-edge-length check
/// is exact regardless of the perpendicularity tolerance under test).
fn parallelogram_step(dot: f64) -> String {
    let y = (1.0 - dot * dot).sqrt();
    let (p1x, p1y) = (1.0, 0.0);
    let (p2x, p2y) = (1.0 + dot, y);
    let (p3x, p3y) = (dot, y);
    format!(
        "#1=IFCCARTESIANPOINT((0.0,0.0));\n\
         #2=IFCCARTESIANPOINT(({p1x},{p1y}));\n\
         #3=IFCCARTESIANPOINT(({p2x},{p2y}));\n\
         #4=IFCCARTESIANPOINT(({p3x},{p3y}));\n\
         #5=IFCPOLYLINE((#1,#2,#3,#4));\n\
         #6=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'Test',#5);\n"
    )
}

#[test]
fn read_rect_profile_2d_accepts_parallelogram_just_inside_perp_tolerance() {
    // dot = 0.009 < 0.01 -> adjacent edges close enough to perpendicular ->
    // treated as a (slightly skewed) rectangle -> Some(...).
    let content = parallelogram_step(0.009);
    let mut decoder = EntityDecoder::new(&content);
    let profile_entity = decoder.decode_by_id(6).unwrap();
    let router = GeometryRouter::new();

    let result = router.read_rect_profile_2d(&profile_entity, &mut decoder);
    assert!(
        result.is_some(),
        "dot=0.009 is within the 0.01 perpendicularity tolerance and must be accepted"
    );
    let (xd, yd, ..) = result.unwrap();
    assert!((xd - 1.0).abs() < 1e-6, "xd should be ~1.0, got {xd}");
    assert!((yd - 1.0).abs() < 1e-6, "yd should be ~1.0, got {yd}");
}

#[test]
fn read_rect_profile_2d_rejects_parallelogram_just_outside_perp_tolerance() {
    // dot = 0.011 > 0.01 -> adjacent edges too far from perpendicular ->
    // NOT accepted as a rectangle -> None. A mutant that loosens the 0.01
    // bound (e.g. widens it towards 0.1) would incorrectly accept this.
    let content = parallelogram_step(0.011);
    let mut decoder = EntityDecoder::new(&content);
    let profile_entity = decoder.decode_by_id(6).unwrap();
    let router = GeometryRouter::new();

    let result = router.read_rect_profile_2d(&profile_entity, &mut decoder);
    assert!(
        result.is_none(),
        "dot=0.011 is outside the 0.01 perpendicularity tolerance and must be rejected, got {result:?}"
    );
}
