// SPDX-License-Identifier: MPL-2.0
//! Interior adjacency for the HBJSON exporter.
//!
//! `IfcSpace` volumes are net (inner-face) air volumes, so two rooms that share a wall have
//! parallel faces separated by the wall thickness — Honeybee's `solve_adjacency` needs
//! coincident faces and won't pair them, leaving interior walls as `Outdoors` (wrong: they
//! would lose heat to ambient). Honeybee *does* accept a manually-set `Surface` boundary
//! condition between two parallel, same-area faces offset by the wall thickness (verified),
//! so this pass proximity-matches wall faces and cross-references them as `Surface` — no
//! geometry change. Only full-wall (equal-area, aligned) pairs are matched; partial overlaps
//! are left exterior (they would need face splitting).

use crate::geom::{center, dot, newell_normal, polygon_area};
use crate::hbjson::Room;

/// Max plane separation to treat as a shared wall (a generous wall thickness), metres.
const MAX_GAP: f64 = 0.6;
/// Max in-plane centroid misalignment for two faces to count as facing each other, metres.
const MAX_LATERAL: f64 = 0.15;
/// Max relative area difference. Honeybee's matching-areas check is strict (net IFC spaces
/// rarely produce perfectly congruent faces), so only near-congruent walls are paired.
const MAX_AREA_DIFF: f64 = 0.01;

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

struct AdjFace {
    ri: usize,
    fi: usize,
    c: [f64; 3],
    n: [f64; 3],
    area: f64,
    face_id: String,
    room_id: String,
}

/// Pair up shared interior faces (walls between side-by-side rooms AND floors/ceilings
/// between stacked rooms) and set reciprocal `Surface` boundary conditions. Returns the
/// number of interior faces created (2 per matched pair).
pub fn solve_adjacency(rooms: &mut [Room]) -> usize {
    // Every planar face is a candidate: anti-parallel normals naturally pick wall↔wall
    // (horizontal normals) and floor↔roof (vertical normals) pairs; same-storey floors
    // (parallel down-normals) and exterior faces never match.
    let mut faces: Vec<AdjFace> = Vec::new();
    for (ri, room) in rooms.iter().enumerate() {
        for (fi, f) in room.faces.iter().enumerate() {
            let b = &f.geometry.boundary;
            if b.len() < 3 {
                continue;
            }
            faces.push(AdjFace {
                ri,
                fi,
                c: center(b),
                n: newell_normal(b),
                area: polygon_area(b),
                face_id: f.identifier.clone(),
                room_id: room.identifier.clone(),
            });
        }
    }

    let mut used = vec![false; faces.len()];
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for i in 0..faces.len() {
        if used[i] {
            continue;
        }
        // Pick the BEST (closest) valid partner, not just the first — multiple anti-parallel
        // same-area faces can fall inside MAX_GAP and first-match could pair the wrong rooms.
        let mut best: Option<(f64, usize)> = None;
        for j in (i + 1)..faces.len() {
            if used[j] {
                continue;
            }
            let (a, b) = (&faces[i], &faces[j]);
            if a.ri == b.ri || dot(a.n, b.n) > -0.95 {
                continue; // same room, or not anti-parallel
            }
            let gap = dot(sub(a.c, b.c), a.n).abs();
            if gap > MAX_GAP {
                continue;
            }
            // b's centroid projected onto a's plane must sit on top of a's centroid.
            let off = dot(sub(b.c, a.c), a.n);
            let b_proj = [
                b.c[0] - a.n[0] * off,
                b.c[1] - a.n[1] * off,
                b.c[2] - a.n[2] * off,
            ];
            let lateral = dist(a.c, b_proj);
            if lateral > MAX_LATERAL {
                continue;
            }
            // Full-face match only (near-equal area → Honeybee's matching-areas check passes).
            if (a.area - b.area).abs() / a.area.max(b.area).max(1e-9) > MAX_AREA_DIFF {
                continue;
            }
            if best.is_none_or(|(bg, _)| gap < bg) {
                best = Some((gap, j));
            }
        }
        if let Some((_, j)) = best {
            pairs.push((i, j));
            used[i] = true;
            used[j] = true;
        }
    }

    for &(i, j) in &pairs {
        let (ri_a, fi_a) = (faces[i].ri, faces[i].fi);
        let (ri_b, fi_b) = (faces[j].ri, faces[j].fi);
        let (fid_a, rid_a) = (faces[i].face_id.clone(), faces[i].room_id.clone());
        let (fid_b, rid_b) = (faces[j].face_id.clone(), faces[j].room_id.clone());
        rooms[ri_a].faces[fi_a].set_surface_bc(fid_b, rid_b);
        rooms[ri_b].faces[fi_b].set_surface_bc(fid_a, rid_a);
    }
    pairs.len() * 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hbjson::{Face, Face3D};

    /// Two square wall faces, 0.5m apart, coplanar-facing (anti-parallel normals,
    /// matching area, zero lateral offset) — the geometry `solve_adjacency` is
    /// built to pair. Room/face identifiers are distinct on purpose so a swap
    /// between "which room" and "which face" is observable in the output.
    fn facing_rooms() -> Vec<Room> {
        // Room A's wall: outward normal +x (winding gives Newell normal (1,0,0)).
        let face_a = Face3D::new(vec![
            [2.0, 0.0, 0.0],
            [2.0, 2.0, 0.0],
            [2.0, 2.0, 2.0],
            [2.0, 0.0, 2.0],
        ]);
        // Room B's wall: outward normal -x, offset 0.5m, same footprint extents.
        let face_b = Face3D::new(vec![
            [2.5, 0.0, 0.0],
            [2.5, 0.0, 2.0],
            [2.5, 2.0, 2.0],
            [2.5, 2.0, 0.0],
        ]);
        let room_a = Room::new(
            "RoomA".to_string(),
            vec![Face::new("FaceA".to_string(), face_a, "Wall", "Outdoors")],
        );
        let room_b = Room::new(
            "RoomB".to_string(),
            vec![Face::new("FaceB".to_string(), face_b, "Wall", "Outdoors")],
        );
        vec![room_a, room_b]
    }

    /// Mutation killed: swapping `vec![adjacent_face, adjacent_room]` to
    /// `vec![adjacent_room, adjacent_face]` inside `BoundaryCondition::surface`
    /// (hbjson.rs) survived the full suite — every existing assertion only checks
    /// `boundary_condition_objects.len() == 2`, never which slot holds the face id
    /// vs. the room id, and never that room A's face points at room B (not itself).
    /// This test pins both the slot order and the cross-room identity.
    #[test]
    fn solve_adjacency_pairs_faces_with_correct_face_then_room_order() {
        let mut rooms = facing_rooms();
        let created = solve_adjacency(&mut rooms);
        assert_eq!(
            created, 2,
            "expected exactly one matched pair (2 interior faces)"
        );

        let bc_a = &rooms[0].faces[0].boundary_condition;
        let bc_b = &rooms[1].faces[0].boundary_condition;
        assert_eq!(bc_a.ty, "Surface");
        assert_eq!(bc_b.ty, "Surface");

        // Room A's face must reference [FaceB, RoomB] — face id first, room id second —
        // and NOT its own room.
        let objs_a = bc_a
            .boundary_condition_objects
            .as_ref()
            .expect("room A objects");
        assert_eq!(
            objs_a.as_slice(),
            ["FaceB".to_string(), "RoomB".to_string()].as_slice()
        );

        // Room B's face must reference [FaceA, RoomA], the mirror image.
        let objs_b = bc_b
            .boundary_condition_objects
            .as_ref()
            .expect("room B objects");
        assert_eq!(
            objs_b.as_slice(),
            ["FaceA".to_string(), "RoomA".to_string()].as_slice()
        );
    }
}
