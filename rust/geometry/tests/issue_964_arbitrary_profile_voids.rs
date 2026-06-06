// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #964 — complex profile voids render as rectangles.
//!
//! The reporter's slab (GUID `3qy29DaXf0ivOFkuocsP7z`, express #6443) is a
//! Revit export that *double-encodes* its voids: the slab body is an
//! `IfcExtrudedAreaSolid` over an `IfcArbitraryProfileDefWithVoids` whose
//! inner curves already cut a rectangle, an ellipse and a hexagon, AND the
//! same three voids are re-authored as `IfcOpeningElement`s linked by
//! `IfcRelVoidsElement`.
//!
//! The slab *body* tessellates the round/polygonal holes correctly. The bug
//! was in the redundant opening pass: CSG finds nothing to remove (the host
//! is already hollow there) and the AABB fallback then carves each opening's
//! bounding box, replacing the correct ellipse/hexagon holes with rectangles.
//!
//! This test drives the production void path (`process_element_with_voids`)
//! and asserts the slab's solid bottom-cap area after the opening pass stays
//! equal to the un-cut body's — i.e. the openings did not rectangularize the
//! holes. The buggy AABB fallback removed ~3% more material (each round/hex
//! hole grew to its bounding box), which this tolerance rejects.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

const FIXTURE: &str = "tests/models/issues/964_slab_arbitrary_profile_voids.ifc";
/// IfcSlab `3qy29DaXf0ivOFkuocsP7z` — body uses IfcArbitraryProfileDefWithVoids.
const SLAB_ID: u32 = 6443;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(FIXTURE)
}

/// Build the void index the same way production does (scan IfcRelVoidsElement).
fn build_void_index_like_production(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

/// Sum of |XY area| of triangles lying on the mesh's bottom face (z ≈ z_min).
/// For an extruded slab this equals the solid cross-section area: outer
/// rectangle minus the holes. Round/hex holes ⇒ ~7.46e6; if a hole is cut to
/// its bounding box instead ⇒ ~7.24e6.
fn bottom_cap_area(mesh: &Mesh) -> f64 {
    let mut z_min = f32::INFINITY;
    for p in mesh.positions.chunks_exact(3) {
        if p[2] < z_min {
            z_min = p[2];
        }
    }
    let tol = 1e-3_f32;
    let mut area = 0.0f64;
    for tri in mesh.indices.chunks_exact(3) {
        let a = tri[0] as usize * 3;
        let b = tri[1] as usize * 3;
        let c = tri[2] as usize * 3;
        if (mesh.positions[a + 2] - z_min).abs() < tol
            && (mesh.positions[b + 2] - z_min).abs() < tol
            && (mesh.positions[c + 2] - z_min).abs() < tol
        {
            let (ax, ay) = (mesh.positions[a] as f64, mesh.positions[a + 1] as f64);
            let (bx, by) = (mesh.positions[b] as f64, mesh.positions[b + 1] as f64);
            let (cx, cy) = (mesh.positions[c] as f64, mesh.positions[c + 1] as f64);
            area += ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)).abs() * 0.5;
        }
    }
    area
}

#[test]
fn redundant_openings_do_not_rectangularize_profile_voids() {
    let content = match std::fs::read_to_string(fixture_path()) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "skipping issue-964 regression: fixture missing at {FIXTURE}; run `pnpm fixtures`"
            );
            return;
        }
    };

    let void_index = build_void_index_like_production(&content);
    assert!(
        void_index.get(&SLAB_ID).map(|v| v.len()).unwrap_or(0) >= 2,
        "expected the slab to carry redundant IfcOpeningElements"
    );

    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);

    let slab = decoder.decode_by_id(SLAB_ID).expect("decode slab");

    // Body alone (profile-with-voids): the reference correct hole area.
    let body = router.process_element(&slab, &mut decoder).expect("body");
    let body_area = bottom_cap_area(&body);
    assert!(body_area > 1.0, "body produced no bottom cap");

    // Production void path: opening boolean cuts applied on top of the body.
    let slab = decoder.decode_by_id(SLAB_ID).expect("decode slab");
    let cut = router
        .process_element_with_voids(&slab, &mut decoder, &void_index)
        .expect("voided slab");
    let cut_area = bottom_cap_area(&cut);

    // The redundant openings must leave the solid cross-section unchanged: the
    // ellipse and hexagon holes stay round/hex, not their bounding boxes.
    // The pre-fix AABB fallback removed ~3% more material; allow 0.5% slack
    // for re-tessellation around the (harmless) rectangular opening.
    let rel_diff = (body_area - cut_area).abs() / body_area;
    assert!(
        rel_diff < 0.005,
        "opening pass changed the slab's solid area by {:.2}% (body={:.1}, cut={:.1}); \
         the complex profile voids were likely rectangularized by the AABB fallback",
        rel_diff * 100.0,
        body_area,
        cut_area,
    );
}
