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
//! non-empty host. The processor now does the same and records the
//! fallback as `BoolFailureReason::DifferenceEmptiedHost`.
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
            "wall #{} produced an empty mesh — DIFFERENCE clip emptied the host \
             (issue #821: the spec-strict subtract removes the whole wall, the \
             fallback must revert to the un-cut host)",
            wall_id,
        );

        // Sanity: the un-cut wall body is an 8200×200×3850 (or rotated)
        // extrusion. Verifying the Z-span survived at full height proves
        // the fallback actually used the wall body rather than an
        // unrelated mesh.
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

#[test]
fn difference_emptied_host_is_recorded_in_csg_failures() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    // Process each wall's body chain directly through `BooleanClippingProcessor`
    // so we can drain its own failure log. The router's `take_csg_failures`
    // sees only the *router*-attributed failures (those routed through the
    // void-aware path) and would silently report 0 here even when the guard
    // is firing inside the boolean processor on every call.
    let schema = ifc_lite_core::IfcSchema::new();
    let boolean = ifc_lite_geometry::BooleanClippingProcessor::new();

    for &wall_id in BROKEN_OUTSIDE_WALLS {
        let wall = decoder
            .decode_by_id(wall_id)
            .unwrap_or_else(|e| panic!("decode wall #{} ({})", wall_id, e));
        let rep_id = wall.get_ref(6).expect("wall has representation");
        let product_shape = decoder.decode_by_id(rep_id).expect("decode rep");
        let reprs = product_shape
            .get(2)
            .and_then(|a| a.as_list())
            .expect("rep list");
        for r in reprs {
            let Some(shape_repr_id) = r.as_entity_ref() else {
                continue;
            };
            let shape_repr = decoder.decode_by_id(shape_repr_id).expect("decode shape");
            let rep_type = shape_repr
                .get(2)
                .and_then(|a| a.as_string().map(String::from))
                .unwrap_or_default();
            if rep_type != "Clipping" && rep_type != "Body" {
                continue;
            }
            let items = shape_repr
                .get(3)
                .and_then(|a| a.as_list())
                .expect("items list");
            for it in items {
                let Some(item_id) = it.as_entity_ref() else {
                    continue;
                };
                let Ok(item) = decoder.decode_by_id(item_id) else {
                    continue;
                };
                if item.ifc_type != ifc_lite_core::IfcType::IfcBooleanClippingResult
                    && item.ifc_type != ifc_lite_core::IfcType::IfcBooleanResult
                {
                    continue;
                }
                let _ =
                    ifc_lite_geometry::GeometryProcessor::process(&boolean, &item, &mut decoder, &schema);
            }
        }
    }

    let failures = boolean.take_failures();
    let total_emptied: usize = failures
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
        "expected ≥1 DifferenceEmptiedHost diagnostic when processing the \
         three broken outside walls — got 0 (the guard never fired and \
         this test was previously a silent pass)",
    );
}
