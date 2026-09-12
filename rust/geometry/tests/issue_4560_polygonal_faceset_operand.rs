// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #4560 — a wall whose Body is a chain of
//! `IfcBooleanResult(.DIFFERENCE., …)` steps with `IfcPolygonalFaceSet`
//! cutters rendered as the full, un-cut extrusion and overshot the roof up to
//! the ridge.
//!
//! The fixture is the reporter's `Test.ifc`, as authored by Bonsai
//! 0.8.6-alpha / IfcOpenShell (IFC4X3_ADD2; no client data, per the issue's
//! privacy checkbox): a 10 m × 0.05 m × 3.8816 m wall (#1216, body #1450) and a
//! gable roof whose two slopes are embedded in the wall body as two
//! closed-shell `IfcPolygonalFaceSet` slabs (#1440, #1448). The undersides of
//! those slabs are the roof planes — both at a 10° pitch, meeting over the
//! wall's midpoint at exactly the extrusion height — so a correctly cut wall
//! is a gable: full height only at the ridge, dropping to ≈3.0 m at both ends.
//!
//! Root cause: the boolean operand resolver kept its own hand-written list of
//! meshable operand types instead of the router's built-in table, and
//! `IfcPolygonalFaceSet` was never on it, so each cutter meshed EMPTY and the
//! host came back un-cut with an `UnsupportedOperand` record.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{BoolFailureReason, GeometryRouter, Mesh};

const FIXTURE: &str = "tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc";
const WALL: u32 = 1216;

// Wall body, in metres, straight from #1420 / #1428 (all placements in the
// fixture are identity, so local == world).
const WALL_LENGTH: f32 = 10.0;
const WALL_HEIGHT: f32 = 3.881_635;
// Roof planes from the cutters' point lists (#1433, #1441): each underside
// runs through (4.015192, 4.055283) and (10.984808, 2.826352) (mirrored for
// the other slope), i.e. a 10° pitch peaking over x = 5.
const RIDGE_X: f32 = 5.0;
const PITCH: f32 = 0.176_327; // tan(10°) = (4.055283 - 2.826352) / (10.984808 - 4.015192)

/// Height of the roof underside above a point on the wall's axis.
fn roof_z(x: f32) -> f32 {
    WALL_HEIGHT - PITCH * (x - RIDGE_X).abs()
}

fn process_wall() -> (Mesh, Vec<String>) {
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("read fixture {FIXTURE}: {e}"));
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let wall = decoder
        .decode_by_id(WALL)
        .unwrap_or_else(|e| panic!("decode wall #{WALL}: {e:?}"));
    assert_eq!(wall.ifc_type, IfcType::IfcWall);
    let mesh = router
        .process_element(&wall, &mut decoder)
        .unwrap_or_else(|e| panic!("process wall #{WALL}: {e:?}"));
    let unsupported = router
        .take_csg_failures()
        .into_values()
        .flatten()
        .filter_map(|f| match f.reason {
            BoolFailureReason::UnsupportedOperand(ty) => Some(ty),
            _ => None,
        })
        .collect();
    (mesh, unsupported)
}

#[test]
fn issue_4560_polygonal_faceset_cutters_trim_the_wall_to_the_roof() {
    let (mesh, unsupported) = process_wall();
    assert!(
        unsupported.is_empty(),
        "IfcPolygonalFaceSet is a router built-in and must be a boolean operand too; \
         the operand path filed {unsupported:?} as UnsupportedOperand (issue #4560)"
    );

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    let mut worst_overshoot = 0.0f32;
    for p in mesh.positions.chunks_exact(3) {
        for a in 0..3 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
        worst_overshoot = worst_overshoot.max(p[2] - roof_z(p[0]));
    }

    // The cut must not have deleted or shrunk the wall: full footprint, on the
    // ground, and the ridge vertex (where the two roof planes meet the top of
    // the extrusion) still at full height.
    assert!(!mesh.is_empty(), "wall #{WALL} meshed empty");
    assert!(min[0].abs() < 1e-3 && (max[0] - WALL_LENGTH).abs() < 1e-3, "x span {min:?}..{max:?}");
    assert!(min[2].abs() < 1e-3, "wall base z = {}", min[2]);
    assert!(
        max[2] > WALL_HEIGHT - 0.01,
        "ridge lost: max z {} < extrusion height {WALL_HEIGHT}",
        max[2]
    );

    // The regression proper: no vertex may sit above the roof underside. The
    // un-cut extrusion has its four top corners at z = 3.88 over x = 0 and
    // x = 10, where the roof is at ≈3.0 m, so on the broken path this
    // overshoot is ≈0.88 m.
    assert!(
        worst_overshoot < 2e-3,
        "wall runs {worst_overshoot:.3} m above the roof planes: the polygonal \
         cutters were not applied (issue #4560)"
    );

    // …and the eaves were really cut, not merely the ridge kept: at both wall
    // ends the top edge is now ≈3.0 m, not 3.88 m.
    for end_x in [0.0f32, WALL_LENGTH] {
        let end_top = mesh
            .positions
            .chunks_exact(3)
            .filter(|p| (p[0] - end_x).abs() < 1e-3)
            .map(|p| p[2])
            .fold(f32::NEG_INFINITY, f32::max);
        assert!(
            (end_top - roof_z(end_x)).abs() < 2e-3,
            "top of wall at x = {end_x}: {end_top:.4} m, expected the eave at {:.4} m",
            roof_z(end_x)
        );
    }
}
