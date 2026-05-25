// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for the door-glass Z-fight on issue #674.
//!
//! Root cause: `process_planar_face` triangulated each `IfcFaceBound` of an
//! `IfcAdvancedFace` as an independent solid polygon, ignoring `IfcFaceOuterBound`
//! vs hole semantics. The door panel #712 has a rectangular hole for the glass;
//! the previous output was the outer quad + a coplanar reversed-winding filler
//! over the hole, identical-plane / opposite-normal, surfacing as a wedge-shaped
//! Z-fight under `cullMode: 'none'` in the WebGPU pipeline.
//!
//! After the fix, the panel emits the canonical annular triangulation around the
//! hole and matches IfcOpenShell's 32-tri output exactly.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use std::fs;

const FIXTURE: &str = "tests/models/various/issue-604-door.ifc";
const PANEL_BREP: u32 = 712;

#[test]
fn door_panel_brep_emits_annular_triangulation_no_zfight_filler() {
    let Ok(content) = fs::read_to_string(format!("../../{}", FIXTURE)) else {
        eprintln!("skip: fixture missing — run `pnpm fixtures`");
        return;
    };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    let entity = decoder.decode_by_id(PANEL_BREP).expect("decode panel");
    assert_eq!(entity.ifc_type, IfcType::IfcAdvancedBrep);
    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("panel tessellation must succeed");

    // 32 = 8 outer side walls + 8 inner hole walls + 8 front annulus + 8 back
    // annulus. IfcOpenShell on the same brep emits exactly 32 tris.
    let tri_count = mesh.indices.len() / 3;
    assert_eq!(
        tri_count, 32,
        "panel should emit 32 tris (8 outer + 8 inner walls + 8 front/back annulus each), got {tri_count}",
    );

    // For each pair of triangles on the same axis-aligned plane, the normals
    // must agree (no reversed-winding filler). Pre-fix the panel front (y=130)
    // had tris with n=(0,-1,0) AND n=(0,+1,0) overlapping — the artifact.
    let positions = &mesh.positions;
    let indices = &mesh.indices;
    let mut front_normals_y: Vec<f32> = Vec::new();
    let mut back_normals_y: Vec<f32> = Vec::new();
    for tri in indices.chunks_exact(3) {
        let (a, b, c) = (tri[0] as usize * 3, tri[1] as usize * 3, tri[2] as usize * 3);
        let v0 = [positions[a], positions[a + 1], positions[a + 2]];
        let v1 = [positions[b], positions[b + 1], positions[b + 2]];
        let v2 = [positions[c], positions[c + 1], positions[c + 2]];
        // All three on y=130 (panel front) or y=175 (panel back)?
        if (v0[1] - 130.0).abs() < 0.01 && (v1[1] - 130.0).abs() < 0.01 && (v2[1] - 130.0).abs() < 0.01 {
            // Compute normal y-component from cross product
            let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
            let ny = e1[2] * e2[0] - e1[0] * e2[2];
            front_normals_y.push(ny.signum());
        }
        if (v0[1] - 175.0).abs() < 0.01 && (v1[1] - 175.0).abs() < 0.01 && (v2[1] - 175.0).abs() < 0.01 {
            let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
            let ny = e1[2] * e2[0] - e1[0] * e2[2];
            back_normals_y.push(ny.signum());
        }
    }

    assert_eq!(front_normals_y.len(), 8, "expected 8 tris on front plane y=130");
    assert_eq!(back_normals_y.len(), 8, "expected 8 tris on back plane y=175");
    let front_all_same = front_normals_y.iter().all(|s| *s == front_normals_y[0]);
    let back_all_same = back_normals_y.iter().all(|s| *s == back_normals_y[0]);
    assert!(
        front_all_same,
        "front-plane tris have mixed normal signs (Z-fight regression): {:?}",
        front_normals_y,
    );
    assert!(
        back_all_same,
        "back-plane tris have mixed normal signs (Z-fight regression): {:?}",
        back_normals_y,
    );
}
