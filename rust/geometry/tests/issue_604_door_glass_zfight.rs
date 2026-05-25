// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for the Z-fight artefact on the Revit door glass pane.
//!
//! The door's glass `IfcAdvancedBrep` (#1227, y=[150, 155]) was exactly
//! coplanar with the two metal-trim breps (#1778 y_min=155, #2326 y_max=150)
//! on its front and back faces, plus the panel (#712, y=[130, 175]) that
//! envelops it. When `process_element_with_submeshes` dispatches a door,
//! the new `dedupe_coplanar_submeshes` pass nudges the smaller-by-vertex-
//! count sub-mesh (glass) inward on both Y planes, breaking the depth tie
//! without altering the metal trim or panel.
//!
//! Fixture: `tests/models/various/issue-604-door.ifc` — skips cleanly if
//! the model is missing (`pnpm fixtures` to fetch).

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use std::path::Path;

const FIXTURE: &str = "../../tests/models/various/issue-604-door.ifc";
const DOOR_ID: u32 = 2390;
const GLASS_BREP: u32 = 1227;

fn read_fixture() -> Option<String> {
    if !Path::new(FIXTURE).exists() {
        eprintln!(
            "skipping issue-604 glass z-fight regression: fixture missing at {FIXTURE} — \
             run `pnpm fixtures` from the repo root",
        );
        return None;
    }
    std::fs::read_to_string(FIXTURE).ok()
}

/// After dispatching the door through `process_element_with_submeshes`, the
/// glass sub-mesh must have its Y extent shrunk inward by 2 ε on both
/// faces — original 5 mm thickness becomes 5 − 2ε mm. ε is auto-derived
/// from `5e-5 × max_sub_mesh_extent`. With the door's tallest sub-shell at
/// ~2100 mm, ε ≈ 0.105 mm so the post-fix glass thickness ≈ 4.79 mm.
#[test]
fn glass_submesh_is_inset_to_break_coplanar_zfight() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    let door = decoder.decode_by_id(DOOR_ID).expect("decode door");
    assert_eq!(door.ifc_type, IfcType::IfcDoor);

    let submeshes = router
        .process_element_with_submeshes(&door, &mut decoder)
        .expect("door submesh dispatch must succeed");

    // Locate the glass sub-mesh by its geometry_id.
    let glass = submeshes
        .iter()
        .find(|sm| sm.geometry_id == GLASS_BREP)
        .expect("glass sub-mesh missing from door dispatch");

    let mut y_min = f32::INFINITY;
    let mut y_max = f32::NEG_INFINITY;
    for c in glass.mesh.positions.chunks_exact(3) {
        if c[1] < y_min {
            y_min = c[1];
        }
        if c[1] > y_max {
            y_max = c[1];
        }
    }
    let thickness = y_max - y_min;

    // Expected ε from the dedup pass: ~5e-5 × 2100 mm = 0.105 mm. The exact
    // value depends on which sub-shell has the maximum extent (Frame at
    // 2100 z-mm). Assert the thickness is in the [4.7, 4.95] mm band — well
    // inside the expected 5 − 2ε for ε ∈ [0.05, 0.15] mm.
    assert!(
        thickness > 4.7 && thickness < 4.95,
        "glass Y extent should shrink from 5 mm to ~(5 − 2ε) ≈ 4.79 mm, got {thickness:.4} mm \
         — coplanar-dedup pass regressed"
    );

    // Glass must still sit STRICTLY INSIDE the original world band
    // [−55, −50] (local [150, 155] mirrored by the door's 180° Z-rotation):
    // shrink direction is inward (toward the brep's interior).
    assert!(
        y_min > -55.0 && y_max < -50.0,
        "glass Y extent must shrink inward, got world y=[{y_min:.4}, {y_max:.4}]"
    );

    // The neighbour metal-trim breps (#1778, #2326) must NOT have been
    // shrunk on the planes shared with glass — they are the bigger
    // sub-meshes (810 / 801 verts vs glass's 24) so the dedup leaves their
    // glass-facing faces in place. The door's local +Y axis maps to world
    // −Y after the 180° Z-rotation in #2448, so metal-pt-1 (#1778) faces
    // glass at WORLD y=−55 (local y=155) and metal-pt-2 (#2326) faces
    // glass at WORLD y=−50 (local y=150).
    let metal_top = submeshes
        .iter()
        .find(|sm| sm.geometry_id == 1778)
        .expect("metal-trim #1778 missing");
    let metal_bot = submeshes
        .iter()
        .find(|sm| sm.geometry_id == 2326)
        .expect("metal-trim #2326 missing");

    let mut metal_top_y_max = f32::NEG_INFINITY;
    for c in metal_top.mesh.positions.chunks_exact(3) {
        if c[1] > metal_top_y_max {
            metal_top_y_max = c[1];
        }
    }
    let mut metal_bot_y_min = f32::INFINITY;
    for c in metal_bot.mesh.positions.chunks_exact(3) {
        if c[1] < metal_bot_y_min {
            metal_bot_y_min = c[1];
        }
    }
    assert!(
        (metal_top_y_max - (-55.0)).abs() < 1e-3,
        "metal-trim #1778 y_max should stay at world y=−55, got {metal_top_y_max:.4}"
    );
    assert!(
        (metal_bot_y_min - (-50.0)).abs() < 1e-3,
        "metal-trim #2326 y_min should stay at world y=−50, got {metal_bot_y_min:.4}"
    );
}
