// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #821 — `IfcBooleanClippingResult.DIFFERENCE`
//! must not silently emit an empty mesh when the cutter happens to cover
//! the entire host.
//!
//! TallBuilding.ifc is a Revit IFC2x3 export. Its Level 1 "Outside wall"
//! instances (e.g. #615) are authored as
//!
//! ```text
//! #601 = IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE., #597, #600)
//! #597 = IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE., #576, #596)
//! #576 = IFCEXTRUDEDAREASOLID(...)   ; 8200 × 200 × 3850 wall body
//! #596 = IFCPOLYGONALBOUNDEDHALFSPACE(plane, .T., position, polygon)
//! #600 = IFCHALFSPACESOLID(plane, .T.)
//! ```
//!
//! The cutters land at the top and bottom of the wall body — strict-spec
//! evaluation makes the half-space material exactly cover the host, so
//! the DIFFERENCE produces an empty mesh and the outside walls vanish
//! from the render (the user's reported bug).
//!
//! Reference viewers (BIMVision in the user's comparison screenshot)
//! defensively revert to the un-cut host when DIFFERENCE wipes out a
//! non-empty host, and the processor's `DifferenceEmptiedHost` guard does the
//! same as a safety net.
//!
//! Since the `IfcPolygonalBoundedHalfSpace` material-side fix, though, these
//! walls no longer *empty* in the first place: the polygonal cutters were
//! being built on the wrong side of the plane (engulfing the wall); built on
//! the correct AgreementFlag side they clip to nothing here, so the walls
//! survive at full extent matching IfcOpenShell without the fallback. So the
//! first test pins that correct outcome, and the second exercises the guard
//! directly with a synthetic full-cover clip.
//!
//! Fixture: `tests/models/issues/821_TallBuilding.ifc`.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/821_TallBuilding.ifc";

// Outside walls on Level 1 (#140). All three are the same pattern: an
// 8200×200×3850 (or rotated) extruded body with two clipping ops that —
// per strict spec — would remove the entire wall.
const BROKEN_OUTSIDE_WALLS: &[u32] = &[615, 1297, 2401];

/// See `issue_820_trimmed_curve_planeangleunit::lfs_pointer_prefix` for
/// why this string is built at runtime instead of being a string literal.
fn lfs_pointer_prefix() -> String {
    format!("version {}{}", "https://git-lfs.github.com/", "spec/")
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with(&lfs_pointer_prefix()) => {
            eprintln!(
                "skipping issue-821 regression: fixture at {FIXTURE} is a Git LFS \
                 pointer — run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-821 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn level_1_outside_walls_are_not_emptied_by_top_trim_clips() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    for &wall_id in BROKEN_OUTSIDE_WALLS {
        let wall = decoder
            .decode_by_id(wall_id)
            .unwrap_or_else(|e| panic!("decode wall #{} ({})", wall_id, e));
        assert_eq!(
            wall.ifc_type,
            IfcType::IfcWallStandardCase,
            "expected IfcWallStandardCase at #{}",
            wall_id,
        );

        let mesh = router
            .process_element(&wall, &mut decoder)
            .unwrap_or_else(|e| panic!("process wall #{}: {}", wall_id, e));

        assert!(
            !mesh.positions.is_empty() && !mesh.indices.is_empty(),
            "wall #{} produced an empty mesh — issue #821: the polygonal cutters \
             must clip on the correct AgreementFlag side (and the emptied-host \
             guard is the safety net), leaving the wall at full extent",
            wall_id,
        );

        // Sanity: the wall body is an 8200×200×3850 (or rotated) extrusion, and
        // IfcOpenShell keeps it at exactly that extent (the trims clip to
        // nothing). Verifying the Z-span survived at full height proves the
        // cutters clipped correctly rather than removing the wall.
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for p in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                if p[axis] < min[axis] {
                    min[axis] = p[axis];
                }
                if p[axis] > max[axis] {
                    max[axis] = p[axis];
                }
            }
        }
        let span_z = max[2] - min[2];
        assert!(
            (span_z - 3850.0).abs() < 1.0,
            "wall #{} Z-span {:.1} mm — expected 3850 (full wall height)",
            wall_id,
            span_z,
        );
        let plan_max = (max[0] - min[0]).max(max[1] - min[1]);
        let plan_min = (max[0] - min[0]).min(max[1] - min[1]);
        // Long edge is 7800–8200 depending on the wall (Revit profile
        // lengths vary slightly with their corner trims). Just verify
        // it's clearly a wall-scale span, not a sliver.
        assert!(
            plan_max > 7000.0 && plan_max < 9000.0,
            "wall #{} long edge {:.1} mm — expected ~7800-8200",
            wall_id,
            plan_max,
        );
        assert!(
            (plan_min - 200.0).abs() < 1.0,
            "wall #{} short edge {:.1} mm — expected 200 (wall thickness)",
            wall_id,
            plan_min,
        );
    }
}

/// The `DifferenceEmptiedHost` guard reverts a DIFFERENCE that wipes out a
/// non-empty host when the cutter plane rides the host surface (the defensive
/// fallback BIMVision-style viewers use), recording the loss.
///
/// The issue #821 walls above no longer reach this guard: their emptying was
/// caused by `IfcPolygonalBoundedHalfSpace` cutters built on the wrong side of
/// the plane (engulfing the wall), and that root cause is now fixed — the
/// cutters clip correctly and the walls survive at full extent without the
/// fallback (see `level_1_outside_walls_are_not_emptied_by_top_trim_clips`).
///
/// So exercise the guard directly with a synthetic case that genuinely empties
/// the host: a 10×10×10 box minus a half-space whose plane sits 5 mm above the
/// box's top face (within the guard's coincidence tolerance) with
/// `AgreementFlag = .T.`. The DIFFERENCE removes everything; the guard must
/// revert to the box and record `DifferenceEmptiedHost`.
#[test]
fn difference_emptied_host_is_recorded_in_csg_failures() {
    let content = "\
ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(),(),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,10.);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCAXIS2PLACEMENT3D(#2,#3,$);
#5=IFCEXTRUDEDAREASOLID(#1,#4,#3,10.);
#6=IFCCARTESIANPOINT((0.,0.,10.005));
#7=IFCAXIS2PLACEMENT3D(#6,#3,$);
#8=IFCPLANE(#7);
#9=IFCHALFSPACESOLID(#8,.T.);
#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#5,#9);
ENDSEC;
END-ISO-10303-21;
";
    let entity_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let schema = ifc_lite_core::IfcSchema::new();
    let boolean = ifc_lite_geometry::BooleanClippingProcessor::new();

    let item = decoder.decode_by_id(10).expect("decode boolean clipping result");
    let mesh = ifc_lite_geometry::GeometryProcessor::process(&boolean, &item, &mut decoder, &schema)
        .expect("process boolean clipping result");

    // The guard must revert to the un-cut box, not emit an empty mesh.
    assert!(
        !mesh.indices.is_empty(),
        "expected the guard to revert to the host box, got an empty mesh",
    );
    let total_emptied: usize = boolean
        .take_failures()
        .iter()
        .filter(|f| {
            matches!(
                f.reason,
                ifc_lite_geometry::BoolFailureReason::DifferenceEmptiedHost
            )
        })
        .count();
    assert!(
        total_emptied > 0,
        "expected a DifferenceEmptiedHost diagnostic when a full-cover clip \
         empties a non-empty host — got {total_emptied}",
    );
}
