// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #845 follow-up — the wall-elemented-case
//! fixture authors the drywall as a MappedRepresentation with six
//! `IfcCartesianTransformationOperator3DNonUniform` instances, each
//! scaling the unit-cube source representation to a different
//! tall-narrow or short-wide strip (so the six pieces together cover
//! the wall minus the door + window openings).
//!
//! Pre-fix `parse_cartesian_transformation_operator` read only attr 3
//! (Scale / Scale1) and applied it uniformly to all three axes — the
//! six strips collapsed to tiny cubes ≈ 0.25 × 0.25 × 0.25 of the
//! unit source, so the "drywall" rendered as a sparse pattern of cube
//! fragments instead of one continuous wall sheet with cutouts.
//!
//! This test asserts the panel mesh has a vertical extent ≥ 1 m
//! (Y scale = 2.5 × 0.8 m unit = 2.0 m — full wall height) on at
//! least one of the six pieces. Pre-fix, every piece had < 0.3 m on
//! Y because the X-scale (0.25) was incorrectly applied to Y too.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/845_wall_elemented_case.ifc";
const PANEL_FORWARD_ID: u32 = 145;

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!("issue-845 fixture is an LFS pointer — skipping");
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("issue-845 fixture missing — skipping (run `pnpm fixtures`)");
            None
        }
        Err(e) => panic!("failed to read fixture: {e}"),
    }
}

#[test]
fn drywall_panel_pieces_honor_per_axis_scale() {
    let Some(content) = read_fixture() else { return };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let panel = decoder
        .decode_by_id(PANEL_FORWARD_ID)
        .expect("decode IfcBuildingElementPart #145 (Panel Forward)");

    let mesh = router
        .process_element(&panel, &mut decoder)
        .expect("process Panel Forward");
    assert!(!mesh.is_empty(), "Panel Forward must produce geometry");

    let (lo, hi) = mesh.bounds();
    let span = (hi - lo).abs();

    // The fixture authors the wall in INCHES (the IfcCartesianPoint
    // coords are in inch units per the project's IfcUnitAssignment);
    // unit_scale = 0.0254 m/in is applied by the router. The wall
    // is ~120" × ~80" × ~0.5" — about 3 m × 2 m × 0.013 m.
    //
    // The placement rotates so the panel's normal axis ends up on
    // world-Y. So two of the three world spans should be the panel's
    // surface dimensions (each ≥ 1 m) and the smallest world span is
    // the drywall thickness (~13 mm). Pre-fix every span was ≪ 0.5
    // because the X-scale (~0.25 of the unit source) was incorrectly
    // applied to all three axes.
    let mut surface_spans: [f32; 3] = [span.x, span.y, span.z];
    surface_spans.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let largest = surface_spans[0];
    let second_largest = surface_spans[1];
    assert!(
        largest > 1.0 && second_largest > 1.0,
        "Panel Forward bbox span ({:.3}, {:.3}, {:.3}) m too small — \
         the non-uniform mapped-item scaling collapsed every panel \
         piece to its X scale (~0.25 of the unit source) on all axes; \
         expected an authored 6-piece sheet ≥ 1 m × 1 m on its two \
         surface axes. Issue #845 follow-up: \
         `parse_cartesian_transformation_operator` was missing Scale2 \
         (attr 5) + Scale3 (attr 6) on the NonUniform operator variant.",
        span.x, span.y, span.z,
    );
}
