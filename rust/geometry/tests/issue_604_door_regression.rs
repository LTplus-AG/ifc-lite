// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #604.
//!
//! Covers all three failures the OP reported on the attached Revit door:
//! 1. **Opening cut**: opening depth == wall depth used to leave a coplanar
//!    sliver on the wall surface (fixed by PR #605, padded extension).
//! 2. **Door handle**: hardware sub-shells (rosette + handle bar) are
//!    `IfcAdvancedBrep` over `IfcCylindricalSurface` and
//!    `IfcSurfaceOfRevolution` — they used to tessellate to empty meshes
//!    before the surface-of-revolution / circle-edge fixes shipped on `main`.
//! 3. **Door glazing**: glass-pane `IfcAdvancedBrep` (planar) used to be
//!    silently dropped under earlier code paths.
//!
//! Fixture lives at `tests/fixtures/issue-604/door.ifc` (downloaded from the
//! issue's `door.ifc.txt` attachment). The test skips cleanly when the
//! fixture is absent so a fresh clone never panics.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;
use std::path::Path;

const FIXTURE: &str = "../../tests/fixtures/issue-604/door.ifc";

// Sub-shell express IDs of the door's body, taken from the IfcShapeAspect
// labels in `tests/fixtures/issue-604/door.ifc`:
//   #2369 'Hardware'        → reps #232, #298, #440, #503
//   #2372 'Panel'           → rep  #712
//   #2375 'Frame/Mullion'   → rep  #1115
//   #2378 'Glass'           → rep  #1227
//   #2381 'Metal Paint'     → reps #1778, #2326
const HANDLE_BREPS: &[u32] = &[232, 298, 440, 503];
const GLASS_BREP: u32 = 1227;
// Wall #55 hosts the door opening #2438 via #2439 (IfcRelVoidsElement).
const WALL_ID: u32 = 55;
const OPENING_ID: u32 = 2438;
const DOOR_ID: u32 = 2390;

fn read_fixture() -> Option<String> {
    if !Path::new(FIXTURE).exists() {
        eprintln!(
            "skipping issue-604 regression: fixture missing at {FIXTURE} — \
             run `curl -sL https://github.com/user-attachments/files/27217337/door.ifc.txt \
             -o tests/fixtures/issue-604/door.ifc`",
        );
        return None;
    }
    std::fs::read_to_string(FIXTURE).ok()
}

/// Half (b) + (c) of #604 — verify door handle (`IfcSurfaceOfRevolution` +
/// `IfcCylindricalSurface` shells) and glazing (planar `IfcAdvancedBrep`)
/// both tessellate to non-empty meshes, AND that all 9 sub-shells of the
/// door survive the per-item dispatch in `process_element_with_submeshes`.
#[test]
fn door_handle_and_glass_meshes_are_non_empty() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Each handle sub-shell must produce real geometry.
    for &id in HANDLE_BREPS {
        let entity = decoder.decode_by_id(id).expect("decode handle brep");
        assert_eq!(entity.ifc_type, IfcType::IfcAdvancedBrep);
        let mesh = router
            .process_representation_item(&entity, &mut decoder)
            .expect("handle tessellation must not error");
        assert!(
            !mesh.positions.is_empty() && !mesh.indices.is_empty(),
            "door handle shell #{id} produced empty mesh — \
             SurfaceOfRevolution/CylindricalSurface tessellation regression"
        );
        assert_eq!(mesh.positions.len() % 3, 0);
        assert_eq!(mesh.indices.len() % 3, 0);
    }

    // Glass pane.
    let glass = decoder.decode_by_id(GLASS_BREP).expect("decode glass brep");
    assert_eq!(glass.ifc_type, IfcType::IfcAdvancedBrep);
    let glass_mesh = router
        .process_representation_item(&glass, &mut decoder)
        .expect("glass tessellation must not error");
    assert!(
        !glass_mesh.positions.is_empty() && !glass_mesh.indices.is_empty(),
        "door glazing shell #{GLASS_BREP} produced empty mesh"
    );

    // Whole-door dispatch: all 9 body sub-shells must survive.
    let door = decoder.decode_by_id(DOOR_ID).expect("decode door");
    assert_eq!(door.ifc_type, IfcType::IfcDoor);
    let submeshes = router
        .process_element_with_submeshes(&door, &mut decoder)
        .expect("door submesh dispatch must succeed");
    assert_eq!(
        submeshes.sub_meshes.len(),
        9,
        "door should expose all 9 AdvancedBrep sub-shells, got {}",
        submeshes.sub_meshes.len(),
    );
    for sub in &submeshes.sub_meshes {
        assert!(
            !sub.mesh.positions.is_empty(),
            "sub-mesh for geom #{} is empty",
            sub.geometry_id,
        );
    }
}

/// Half (a) of #604 — wall opening cut must be clean when the opening's
/// extrusion depth exactly equals the host wall's depth (200 mm == 200 mm
/// in `door.ifc`). Verifies the PR #605 padding fix on a real Revit IFC,
/// not just the synthetic exact-match test in `voids.rs`.
#[test]
fn wall_opening_cut_has_no_coplanar_sliver() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Build a void index that mirrors what processor.rs builds from
    // IfcRelVoidsElement records: {wall_id -> [opening_id, ...]}.
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(WALL_ID, vec![OPENING_ID]);

    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    assert_eq!(wall.ifc_type, IfcType::IfcWall);
    let mesh = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("wall void cut must succeed");

    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "wall mesh empty after void subtraction"
    );

    // Resolve the opening's footprint in world coords by processing the
    // opening element's own representation. We use that AABB to look for
    // sliver triangles that should have been clipped away.
    let opening = decoder.decode_by_id(OPENING_ID).expect("decode opening");
    let opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("opening tessellation");
    assert!(!opening_mesh.positions.is_empty(), "opening mesh empty");

    let (omin, omax) = mesh_bbox(&opening_mesh.positions);
    let (wmin, wmax) = mesh_bbox(&mesh.positions);

    // Sanity — opening has to overlap the wall in XZ.
    assert!(
        omin[0] >= wmin[0] - 1e-3
            && omax[0] <= wmax[0] + 1e-3
            && omin[2] >= wmin[2] - 1e-3
            && omax[2] <= wmax[2] + 1e-3,
        "opening AABB outside wall AABB — fixture changed?"
    );

    // Use the *interior* of the opening footprint (shrink by ~5 % per side)
    // so we don't false-trip on legitimate reveal quads at the opening
    // boundary. The sliver bug leaves triangles whose three vertices are
    // ALL strictly inside the opening footprint AND lie on either the near
    // or far face of the wall (Y == wall_min_y or Y == wall_max_y).
    let inset_x = (omax[0] - omin[0]) * 0.05;
    let inset_z = (omax[2] - omin[2]) * 0.05;
    let interior_x = (omin[0] + inset_x, omax[0] - inset_x);
    let interior_z = (omin[2] + inset_z, omax[2] - inset_z);

    // Wall extrudes along Y (200 mm = 0.2 m). A sliver lives on either Y=0
    // or Y=wall_depth. Tolerance below the smallest opening dimension.
    let face_tol = ((wmax[1] - wmin[1]).abs() * 0.01).max(1e-3);
    let near_y = wmin[1];
    let far_y = wmax[1];

    let positions = &mesh.positions;
    let mut sliver_count = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let p0 = vert(positions, tri[0] as usize);
        let p1 = vert(positions, tri[1] as usize);
        let p2 = vert(positions, tri[2] as usize);

        let all_on_near = (p0[1] - near_y).abs() < face_tol
            && (p1[1] - near_y).abs() < face_tol
            && (p2[1] - near_y).abs() < face_tol;
        let all_on_far = (p0[1] - far_y).abs() < face_tol
            && (p1[1] - far_y).abs() < face_tol
            && (p2[1] - far_y).abs() < face_tol;
        if !(all_on_near || all_on_far) {
            continue;
        }

        let inside = |p: [f32; 3]| -> bool {
            p[0] > interior_x.0
                && p[0] < interior_x.1
                && p[2] > interior_z.0
                && p[2] < interior_z.1
        };
        if inside(p0) && inside(p1) && inside(p2) {
            sliver_count += 1;
        }
    }

    assert_eq!(
        sliver_count, 0,
        "found {sliver_count} wall-face triangle(s) sitting inside the opening footprint — \
         opening cut left a coplanar sliver (regression of #604 / PR #605 fix)",
    );
}

fn vert(positions: &[f32], i: usize) -> [f32; 3] {
    [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
}

fn mesh_bbox(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            if chunk[axis] < min[axis] {
                min[axis] = chunk[axis];
            }
            if chunk[axis] > max[axis] {
                max[axis] = chunk[axis];
            }
        }
    }
    (min, max)
}
