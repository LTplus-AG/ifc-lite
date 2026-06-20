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

use crate::hbjson::Room;
use crate::rooms::{center, dot, newell_normal, polygon_area};

/// Max plane separation to treat as a shared wall (a generous wall thickness), metres.
const MAX_GAP: f64 = 0.6;
/// Max in-plane centroid misalignment for two faces to count as facing each other, metres.
const MAX_LATERAL: f64 = 0.15;
/// Max relative area difference. Honeybee's matching-areas check is strict (net IFC spaces
/// rarely produce perfectly congruent faces), so only near-congruent walls are paired.
const MAX_AREA_DIFF: f64 = 0.01;

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

struct WallFace {
    ri: usize,
    fi: usize,
    c: [f64; 3],
    n: [f64; 3],
    area: f64,
    face_id: String,
    room_id: String,
}

/// Pair up shared interior walls and set reciprocal `Surface` boundary conditions.
/// Returns the number of interior faces created (2 per matched pair).
pub fn solve_adjacency(rooms: &mut [Room]) -> usize {
    let mut faces: Vec<WallFace> = Vec::new();
    for (ri, room) in rooms.iter().enumerate() {
        for (fi, f) in room.faces.iter().enumerate() {
            if f.face_type != "Wall" {
                continue;
            }
            let b = &f.geometry.boundary;
            if b.len() < 3 {
                continue;
            }
            faces.push(WallFace {
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
        for j in (i + 1)..faces.len() {
            if used[j] {
                continue;
            }
            let (a, b) = (&faces[i], &faces[j]);
            if a.ri == b.ri || dot(a.n, b.n) > -0.95 {
                continue; // same room, or not anti-parallel
            }
            // Plane separation along a's normal.
            if dot(sub(a.c, b.c), a.n).abs() > MAX_GAP {
                continue;
            }
            // b's centroid projected onto a's plane must sit on top of a's centroid.
            let off = dot(sub(b.c, a.c), a.n);
            let b_proj = [b.c[0] - a.n[0] * off, b.c[1] - a.n[1] * off, b.c[2] - a.n[2] * off];
            if dist(a.c, b_proj) > MAX_LATERAL {
                continue;
            }
            // Full-wall match only (near-equal area → Honeybee's matching-areas check passes).
            if (a.area - b.area).abs() / a.area.max(b.area).max(1e-9) > MAX_AREA_DIFF {
                continue;
            }
            pairs.push((i, j));
            used[i] = true;
            used[j] = true;
            break;
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
