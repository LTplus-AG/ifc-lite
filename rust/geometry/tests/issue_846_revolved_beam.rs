// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #846 — IfcBeam #227 in the
//! beam-varying-extrusion-paths fixture uses an IfcRevolvedAreaSolid that
//! references a non-trivial Position offset (0, -100, 0) and a revolution
//! axis at (-1300, 100, 0) with direction (0,-1,0). The old processor
//! (a) ignored the IfcSweptAreaSolid Position transform and (b) misused the
//! 2D profile (x,y) coords as (radius, height) along the axis. The result
//! was a tiny ring near the axis location instead of the expected 45° arc
//! sweep of an IPE200 profile around the axis line.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/846_revolved_beam.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-846 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn bounds(mesh: &ifc_lite_geometry::Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

#[test]
fn revolved_beam_sweeps_authored_arc_not_a_degenerate_ring() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let beam = decoder
        .decode_by_id(227)
        .expect("decode IfcBeam #227 (Revolution)");
    assert_eq!(beam.ifc_type, IfcType::IfcBeam);

    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process revolution beam");

    let tri_count = mesh.indices.len() / 3;
    assert!(
        tri_count > 100,
        "expected non-trivial swept mesh, got {tri_count} triangles",
    );

    let (min, max) = bounds(&mesh);
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

    // Authored sweep is a 1300 mm-radius IPE200 (200 mm deep flanges) revolved
    // by 0.79 rad ≈ 45° around an axis offset from the profile origin. The
    // arc length 1300 mm × 0.79 ≈ 1.03 m must appear in the mesh extents,
    // and the profile depth (≈ 0.2 m) must show up on a perpendicular axis.
    // The pre-fix bug produced a tiny ring of order 0.1 m on every axis,
    // located ≈ 1.3 m from the placement origin (the misused axis location).
    assert!(
        span[1] > 0.90,
        "expected long-axis extent ≥0.90 m (arc length ≈1.03 m), got {} \
         (full span {span:?}, bounds {min:?}..{max:?})",
        span[1],
    );
    let cross_axis_max = span[0].max(span[2]);
    assert!(
        cross_axis_max > 0.15,
        "expected perpendicular profile extent ≥0.15 m (IPE200 depth ≈0.2 m), \
         got {cross_axis_max} (full span {span:?})",
    );
}

#[test]
fn extrusion_beam_unchanged_under_revolved_fix() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Beam #210 is a plain IfcExtrudedAreaSolid — touching the
    // RevolvedAreaSolidProcessor must not affect the extrusion path.
    let beam = decoder
        .decode_by_id(210)
        .expect("decode IfcBeam #210 (Extrusion)");
    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process extrusion beam");

    let tri_count = mesh.indices.len() / 3;
    assert!(tri_count > 0, "extrusion beam produced no triangles");

    let (min, max) = bounds(&mesh);
    // The extrusion is a 1 m long IPE200 along world +Z (with local
    // placement rotation). At minimum the mesh must span ≈ 1 m on its
    // long axis.
    let max_span = (max[0] - min[0])
        .max(max[1] - min[1])
        .max(max[2] - min[2]);
    assert!(
        max_span > 0.9,
        "expected extrusion beam to span ≈1 m on its long axis, got {max_span}",
    );
}
