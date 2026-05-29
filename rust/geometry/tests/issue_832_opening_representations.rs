// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #832 — five walls authored with different
//! opening representations should all produce a bounded rectangular hole.
//!
//! Fixture (`tests/models/issues/832_opening_representations.ifc`) is the
//! reporter's minimal repro: 5 walls along world +X, 0.2 m thick, 3 m
//! long, 3 m tall. Each wall has exactly one `IfcRelVoidsElement` →
//! `IfcOpeningElement` with a 1 m × 1 m × 0.2 m authored bounding box
//! centred at y ∈ [0.5, 1.5], z ∈ [1, 2] of the wall. Configurations:
//!
//! | Wall id | Opening profile / extrude                         | Side overlap |
//! |---------|---------------------------------------------------|--------------|
//! | #50     | IfcRectangleProfileDef 1×0.2, vertical 1 m         | full thickness |
//! | #89     | IfcRectangleProfileDef offset (0.5, 0.1), 1 m     | -X stick-out 0.1 m |
//! | #128    | IfcArbitraryClosedProfileDef unit-square, +X 0.2 m | full thickness |
//! | #175    | IfcArbitraryClosedProfileDef, -X extrude 0.2 m     | -X stick-out 0.1 m |
//! | #222    | IfcArbitraryClosedProfileDef, +X extrude 0.2 m     | +X stick-out 0.1 m |
//!
//! User-reported symptom: wall #222 (last) ends up with the cut punching
//! all the way down to the wall base and out the +X edge — a half-space
//! cut, not the authored bounded opening.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;

const FIXTURE: &str = "../../tests/models/issues/832_opening_representations.ifc";

/// (wall_id, opening_id, label).  Wall #222 is the broken one in the screenshot.
const WALLS: &[(u32, u32, &str)] = &[
    (50, 69, "wall1 — rectangle profile, vertical extrude, full thickness"),
    (89, 108, "wall2 — rectangle profile, vertical extrude, -X stick-out"),
    (128, 155, "wall3 — arbitrary profile, +X horiz extrude, full thickness"),
    (175, 202, "wall4 — arbitrary profile, -X horiz extrude, -X stick-out"),
    (222, 249, "wall5 — arbitrary profile, +X horiz extrude, +X stick-out"),
];

/// World-space authored opening bounds (taken from the IFC by hand — see
/// the table at the top of this file). All openings share y ∈ [0.5, 1.5]
/// and z ∈ [1, 2]; only the x extent differs per wall.
fn authored_opening_bounds(wall_id: u32) -> ((f32, f32, f32), (f32, f32, f32)) {
    let x = match wall_id {
        50 => (-0.1, 0.1),
        89 => (1.8, 2.0),
        128 => (3.9, 4.1),
        175 => (5.8, 6.0),
        222 => (8.0, 8.2),
        other => panic!("unexpected wall id #{other}"),
    };
    ((x.0, 0.5, 1.0), (x.1, 1.5, 2.0))
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-832 regression: fixture missing at {FIXTURE} — \
                 add it from the issue attachment"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn mesh_bounds(mesh: &ifc_lite_geometry::Mesh) -> ([f32; 3], [f32; 3]) {
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
    (min, max)
}

/// Z-extent of any wall vertex inside the authored opening footprint
/// (x, y) — used to detect an opening that has been silently widened in Z
/// past its authored z ∈ [1, 2].
fn z_inside_opening_footprint(
    mesh: &ifc_lite_geometry::Mesh,
    open_min: (f32, f32, f32),
    open_max: (f32, f32, f32),
) -> (f32, f32) {
    // For every triangle that lies inside the opening's (x, y) rectangle,
    // collect z values. If the cut went rogue and removed the wall down
    // to the base, the wall mesh will have no triangle covering the
    // authored z ∈ [1, 2] strip, and the surviving triangles will give
    // back a z-range that misses that strip entirely.
    let mut zs = Vec::new();
    for tri in mesh.indices.chunks_exact(3) {
        let mut inside = true;
        let mut tri_z = [0f32; 3];
        for (i, vi) in tri.iter().enumerate() {
            let base = *vi as usize * 3;
            let x = mesh.positions[base];
            let y = mesh.positions[base + 1];
            let z = mesh.positions[base + 2];
            if x < open_min.0 || x > open_max.0 || y < open_min.1 || y > open_max.1 {
                inside = false;
                break;
            }
            tri_z[i] = z;
        }
        if inside {
            for z in tri_z {
                zs.push(z);
            }
        }
    }
    if zs.is_empty() {
        return (f32::NAN, f32::NAN);
    }
    let zmin = zs.iter().cloned().fold(f32::INFINITY, f32::min);
    let zmax = zs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    (zmin, zmax)
}

#[test]
fn all_five_opening_representations_stay_bounded() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Build the wall→[opening] index. The IfcRelVoidsElement ids in the
    // fixture are known up-front (it's a 5-wall scratch model), so we
    // build the index directly from the (wall, opening) pairs above.
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for &(wall_id, opening_id, _) in WALLS {
        void_index.entry(wall_id).or_default().push(opening_id);
    }

    let mut failures: Vec<String> = Vec::new();

    for &(wall_id, _opening_id, label) in WALLS {
        let wall = decoder
            .decode_by_id(wall_id)
            .unwrap_or_else(|e| panic!("decode wall #{wall_id} ({e})"));
        assert_eq!(
            wall.ifc_type,
            IfcType::IfcWall,
            "expected IfcWall at #{wall_id}",
        );

        let mesh = router
            .process_element_with_voids(&wall, &mut decoder, &void_index)
            .unwrap_or_else(|e| panic!("process wall #{wall_id}: {e}"));

        let (wmin, wmax) = mesh_bounds(&mesh);

        // The un-cut wall body spans world z ∈ [0, 3]. Cutting an opening
        // at z ∈ [1, 2] should NOT shrink the wall's overall z-span —
        // the wall material above (z > 2) and below (z < 1) the opening
        // must survive. If the wall mesh suddenly only reaches z = 2 or
        // starts at z = 1, the cut has eaten material it shouldn't.
        let span_z = wmax[2] - wmin[2];
        if !((wmin[2] - 0.0).abs() < 1e-3 && (wmax[2] - 3.0).abs() < 1e-3) {
            failures.push(format!(
                "  {label} (#{wall_id}): wall z-span = [{:.4}, {:.4}] (Δ={:.4}) — \
                 expected [0, 3]; opening eroded the wall outside its z=[1,2] band",
                wmin[2], wmax[2], span_z,
            ));
        }

        // Y-span must also stay [0, 3] — the wall's full length should
        // survive a y ∈ [0.5, 1.5] opening.
        if !((wmin[1] - 0.0).abs() < 1e-3 && (wmax[1] - 3.0).abs() < 1e-3) {
            failures.push(format!(
                "  {label} (#{wall_id}): wall y-span = [{:.4}, {:.4}] — \
                 expected [0, 3]; opening eroded the wall outside its y=[0.5,1.5] band",
                wmin[1], wmax[1],
            ));
        }

        // The opening footprint MUST be a genuine hole — there must be
        // some material immediately above (z just above 2) and below
        // (z just below 1) the authored opening within its (x, y)
        // rectangle. If the cut "punches through", the column at the
        // opening's (x, y) becomes empty everywhere.
        let (open_min_w, open_max_w) = authored_opening_bounds(wall_id);
        // Tighten the footprint to the part that actually overlaps the
        // wall (the partial-overlap walls poke 0.1 m past one face).
        let opening_in_wall_min = (
            open_min_w.0.max(wmin[0]),
            open_min_w.1,
            open_min_w.2,
        );
        let opening_in_wall_max = (
            open_max_w.0.min(wmax[0]),
            open_max_w.1,
            open_max_w.2,
        );
        let (z_inside_min, z_inside_max) =
            z_inside_opening_footprint(&mesh, opening_in_wall_min, opening_in_wall_max);

        // Count vertices below the authored opening (z<0.95), inside the
        // opening (0.95<z<2.05), and above (z>2.05) — restricted to the
        // (x,y) column of the opening. A correct cut keeps the below/above
        // counts unchanged from the un-cut wall (the wall body survives
        // there) and only removes vertices in the middle band.
        let mut below_count = 0usize;
        let mut inside_count = 0usize;
        let mut above_count = 0usize;
        for tri in mesh.indices.chunks_exact(3) {
            let mut centroid = [0.0f32; 3];
            for &vi in tri {
                let b = vi as usize * 3;
                centroid[0] += mesh.positions[b];
                centroid[1] += mesh.positions[b + 1];
                centroid[2] += mesh.positions[b + 2];
            }
            centroid[0] /= 3.0;
            centroid[1] /= 3.0;
            centroid[2] /= 3.0;
            if centroid[0] < opening_in_wall_min.0
                || centroid[0] > opening_in_wall_max.0
                || centroid[1] < opening_in_wall_min.1
                || centroid[1] > opening_in_wall_max.1
            {
                continue;
            }
            if centroid[2] < 0.95 {
                below_count += 1;
            } else if centroid[2] > 2.05 {
                above_count += 1;
            } else {
                inside_count += 1;
            }
        }
        eprintln!(
            "[issue-832] {label} (#{wall_id}): wall bbox=[({:.3},{:.3},{:.3})..({:.3},{:.3},{:.3})] \
             total-tris={} z-inside-footprint=({:.3},{:.3}) \
             tris-in-footprint below/inside/above = {}/{}/{}",
            wmin[0], wmin[1], wmin[2], wmax[0], wmax[1], wmax[2],
            mesh.indices.len() / 3, z_inside_min, z_inside_max,
            below_count, inside_count, above_count,
        );

        // The wall body has triangles at its bottom face (z = 0), top face
        // (z = 3), and the two outer ±0.1 m faces. Inside the opening's
        // (x, y) column, before the cut, there are triangles below (z<1)
        // and above (z>2) the authored opening — chunks of the wall's
        // outer faces. A bounded cut must keep BOTH chunks: removing
        // either means the opening punched outside its authored z range.
        if below_count == 0 {
            failures.push(format!(
                "  {label} (#{wall_id}): no wall triangles below opening \
                 (z<0.95) inside its (x,y) footprint — cut extended below \
                 authored z=[1,2] (most likely the symptom in #832)",
            ));
        }
        if above_count == 0 {
            failures.push(format!(
                "  {label} (#{wall_id}): no wall triangles above opening \
                 (z>2.05) inside its (x,y) footprint — cut extended above \
                 authored z=[1,2]",
            ));
        }

        // Per-face cut signature. The two wall faces of interest are the
        // -X face at world_x = wall_min, and the +X face at world_x =
        // wall_max. The opening AABB tells us which face it actually
        // overlaps; the cut MUST leave the un-overlapped face uncut.
        // Counting plane-aligned triangles is the simplest invariant: a
        // pristine wall face is a single rectangle (2 triangles); a cut
        // face fragments into many.
        let count_face_tris = |target_x: f32| -> usize {
            mesh.indices
                .chunks_exact(3)
                .filter(|tri| {
                    tri.iter().all(|&i| {
                        (mesh.positions[i as usize * 3] - target_x).abs() < 1e-3
                    })
                })
                .count()
        };
        let nx_tris = count_face_tris(wmin[0]);
        let px_tris = count_face_tris(wmax[0]);
        let opening_touches_minus_x = open_min_w.0 <= wmin[0] + 1e-3;
        let opening_touches_plus_x = open_max_w.0 >= wmax[0] - 1e-3;
        eprintln!(
            "[issue-832]   -X face ({:.3}): {} tris (opening touches: {}); +X face ({:.3}): {} tris (opening touches: {})",
            wmin[0], nx_tris, opening_touches_minus_x,
            wmax[0], px_tris, opening_touches_plus_x,
        );
        if !opening_touches_minus_x && nx_tris > 2 {
            failures.push(format!(
                "  {label} (#{wall_id}): -X face at x={:.3} has {} triangles \
                 — should be 2 (pristine rectangle), the opening (x ∈ [{:.3}, {:.3}]) \
                 doesn't reach this face. Cut over-extended through the wall.",
                wmin[0], nx_tris, open_min_w.0, open_max_w.0,
            ));
        }
        if !opening_touches_plus_x && px_tris > 2 {
            failures.push(format!(
                "  {label} (#{wall_id}): +X face at x={:.3} has {} triangles \
                 — should be 2 (pristine rectangle), the opening (x ∈ [{:.3}, {:.3}]) \
                 doesn't reach this face. Cut over-extended through the wall.",
                wmax[0], px_tris, open_min_w.0, open_max_w.0,
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "issue #832 — one or more openings over-cut their host wall:\n{}",
        failures.join("\n"),
    );
}
