// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #845 — IfcWallElementedCase openings are
//! authored on the parent wall (`IfcRelVoidsElement` → IfcWall #123),
//! but the wall itself only carries an 'Axis' curve representation. The
//! actual geometry sits on the wall's aggregated parts (drywall panels,
//! studs, tracks). Pre-fix the openings ran against the empty wall mesh
//! and the cut was a silent no-op; panels/studs covered what should have
//! been the window/door holes.
//!
//! The fix propagates the openings down through the IfcRelAggregates
//! tree from any voided host to its aggregated parts. This test loads
//! the reporter's fixture and confirms the door/window opening rectangles
//! actually carve out triangles from the panel meshes — measured as a
//! drop in face count vs. a wall whose openings never cut anything.

use ifc_lite_processing::{process_geometry, MeshData};

const FIXTURE: &str = "../../tests/models/issues/845_wall_elemented_case.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-845 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn find_by_id(meshes: &[MeshData], id: u32) -> Option<&MeshData> {
    meshes.iter().find(|m| m.express_id == id)
}

#[test]
fn wall_part_meshes_receive_propagated_openings() {
    let Some(content) = read_fixture() else {
        return;
    };

    let result = process_geometry(&content);

    let mut ids: Vec<(u32, String, usize)> = result
        .meshes
        .iter()
        .map(|m| (m.express_id, m.ifc_type.clone(), m.indices.len() / 3))
        .collect();
    ids.sort_by_key(|t| t.0);
    let summary = ids
        .iter()
        .map(|(id, t, tris)| format!("#{id} {} {tris}t", t))
        .collect::<Vec<_>>()
        .join(", ");

    // The drywall panels under the wall (IfcBuildingElementPart #145
    // forward face, #146 reverse face) carry the wall's body geometry
    // via mapped representations. With void propagation they show
    // cut-out openings; without the fix they would be 6 pristine flat
    // slabs of 2 tris each (12 tris total per panel mesh). The Boolean
    // cut for the door + window openings expands that count
    // substantially.
    let panel_forward = find_by_id(&result.meshes, 145);
    let panel_reverse = find_by_id(&result.meshes, 146);
    assert!(
        panel_forward.is_some() && panel_reverse.is_some(),
        "expected #145 and #146 (drywall panels) in result. Got: {summary}",
    );

    let triangulated = |m: &MeshData| m.indices.len() / 3;
    let forward_tris = triangulated(panel_forward.unwrap());
    let reverse_tris = triangulated(panel_reverse.unwrap());
    assert!(
        forward_tris > 24 && reverse_tris > 24,
        "expected both panel meshes to show opening cuts \
         (forward={forward_tris} tris, reverse={reverse_tris} tris). \
         A pristine 6-face slab is 12 tris; pre-fix both panels were \
         exactly 12 because the cut never reached them.",
    );
}
