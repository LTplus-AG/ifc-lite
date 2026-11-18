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
//! the reporter's fixture and confirms the door and window openings reach
//! the wall's four parts and that no part has material in either opening.
//!
//! The parts of this wall are authored around the openings: each drywall
//! panel is six boards, one above the door, one below and one above the
//! window. So the cut removes nothing from them and each board stays a
//! 12-triangle box. An earlier form of this test read "more than 24 triangles
//! on a panel mesh" as proof of a cut. That count came from the post-cut
//! sliver pass bisecting the 12.7 mm boards whenever a cut was attempted,
//! with their surface unchanged.

use ifc_lite_processing::{process_geometry, MeshData};

const FIXTURE: &str = "issues/845_wall_elemented_case.ifc";

fn read_fixture() -> Option<String> {
    ifc_lite_testkit::fixture_text(FIXTURE)
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

    // The wall's two openings reach its four parts: track #130, studs #133
    // and the drywall panels #145 (forward) and #146 (reverse). Pre-fix the
    // parts were no void hosts at all.
    let hosts = result.stats.geometry_diagnostics.as_ref().map(|d| d.hosts_with_openings);
    assert_eq!(hosts, Some(4), "the wall's openings must reach its four parts. Got: {summary}");

    // Each panel is the six boards the file authors, uncut.
    for panel in [145, 146] {
        let boards: Vec<usize> =
            result.meshes.iter().filter(|m| m.express_id == panel).map(|m| m.indices.len() / 3).collect();
        assert_eq!(boards, [12; 6], "panel #{panel} is six boards. Got: {summary}");
    }

    // No part has material in the door (#409) or window (#410) opening, seen
    // along the wall's thickness (y): a 15 x 15 grid inside each outline, none
    // of it under a part triangle.
    let world = |m: &MeshData, i: u32| [0, 2].map(|k| f64::from(m.positions[i as usize * 3 + k]) + m.origin[k]);
    for opening in [409, 410] {
        let mesh = find_by_id(&result.meshes, opening).unwrap_or_else(|| panic!("opening #{opening}. Got: {summary}"));
        let points: Vec<[f64; 2]> = (0..mesh.positions.len() as u32 / 3).map(|i| world(mesh, i)).collect();
        let lo = [0, 1].map(|k| points.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min));
        let hi = [0, 1].map(|k| points.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max));
        assert!(hi[0] - lo[0] > 0.5 && hi[1] - lo[1] > 0.5, "opening #{opening} outline {lo:?}..{hi:?}");
        for part in result.meshes.iter().filter(|m| [130, 133, 145, 146].contains(&m.express_id)) {
            for t in part.indices.chunks_exact(3) {
                let [a, b, c] = [world(part, t[0]), world(part, t[1]), world(part, t[2])];
                let side = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
                for (i, j) in (1..15).flat_map(|i| (1..15).map(move |j| (i, j))) {
                    let s = [lo[0] + (hi[0] - lo[0]) * f64::from(i) / 15.0, lo[1] + (hi[1] - lo[1]) * f64::from(j) / 15.0];
                    let (d0, d1, d2) = (side(a, b, s), side(b, c, s), side(c, a, s));
                    let inside = (d0 > 1e-9 && d1 > 1e-9 && d2 > 1e-9) || (d0 < -1e-9 && d1 < -1e-9 && d2 < -1e-9);
                    assert!(!inside, "part #{} has material in opening #{opening} at {s:?}", part.express_id);
                }
            }
        }
    }
}
