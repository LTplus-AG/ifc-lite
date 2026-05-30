// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Golden tests mirroring the TypeScript reference suite plus triangle-math
//! unit tests.

use crate::narrow::ClashStatus;
use crate::session::ClashSession;
use crate::tri_mesh::TriMesh;
use crate::triangle::{tri_tri_distance, tri_tri_intersect};
use crate::vec3::Vec3;

/// Axis-aligned unit cube (side 1) centred at `[cx, cy, cz]`.
///
/// Returns `(positions, indices, aabb)`: 8 vertices packed `x, y, z`, 12
/// triangles as LOCAL (0-based) indices, and the 6-float AABB
/// `[minx, miny, minz, maxx, maxy, maxz]`.
fn unit_cube(cx: f32, cy: f32, cz: f32) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let h = 0.5f32;
    // 8 corners.
    let corners = [
        [cx - h, cy - h, cz - h],
        [cx + h, cy - h, cz - h],
        [cx + h, cy + h, cz - h],
        [cx - h, cy + h, cz - h],
        [cx - h, cy - h, cz + h],
        [cx + h, cy - h, cz + h],
        [cx + h, cy + h, cz + h],
        [cx - h, cy + h, cz + h],
    ];
    let mut positions = Vec::with_capacity(24);
    for c in &corners {
        positions.extend_from_slice(c);
    }
    // 12 triangles (two per face), winding is irrelevant for these tests.
    let indices: Vec<u32> = vec![
        // -z
        0, 1, 2, 0, 2, 3, // +z
        4, 6, 5, 4, 7, 6, // -y
        0, 5, 1, 0, 4, 5, // +y
        3, 2, 6, 3, 6, 7, // -x
        0, 3, 7, 0, 7, 4, // +x
        1, 5, 6, 1, 6, 2,
    ];
    let aabb = vec![cx - h, cy - h, cz - h, cx + h, cy + h, cz + h];
    (positions, indices, aabb)
}

/// Build a session from a list of cubes, packing the flat arenas the API needs.
fn session_of_cubes(cubes: &[(f32, f32, f32)]) -> ClashSession {
    let mut positions: Vec<f32> = Vec::new();
    let mut pos_ranges: Vec<u32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut idx_ranges: Vec<u32> = Vec::new();
    let mut aabbs: Vec<f32> = Vec::new();

    for &(cx, cy, cz) in cubes {
        let (p, idx, ab) = unit_cube(cx, cy, cz);
        let pos_off = positions.len() as u32;
        let pos_len = p.len() as u32;
        let idx_off = indices.len() as u32;
        let idx_len = idx.len() as u32;

        positions.extend_from_slice(&p);
        indices.extend_from_slice(&idx);
        aabbs.extend_from_slice(&ab);
        pos_ranges.push(pos_off);
        pos_ranges.push(pos_len);
        idx_ranges.push(idx_off);
        idx_ranges.push(idx_len);
    }

    let mut session = ClashSession::new();
    session.ingest(&positions, &pos_ranges, &indices, &idx_ranges, &aabbs);
    session
}

/// Axis-aligned cube of arbitrary `side` centred at `(cx, cy, cz)`. Same packing
/// as `unit_cube`, used for enclosure tests where the two cubes differ in size.
fn sized_cube(cx: f32, cy: f32, cz: f32, side: f32) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let h = side / 2.0;
    let corners = [
        [cx - h, cy - h, cz - h],
        [cx + h, cy - h, cz - h],
        [cx + h, cy + h, cz - h],
        [cx - h, cy + h, cz - h],
        [cx - h, cy - h, cz + h],
        [cx + h, cy - h, cz + h],
        [cx + h, cy + h, cz + h],
        [cx - h, cy + h, cz + h],
    ];
    let mut positions = Vec::with_capacity(24);
    for c in &corners {
        positions.extend_from_slice(c);
    }
    let indices: Vec<u32> = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
        1, 5, 6, 1, 6, 2,
    ];
    let aabb = vec![cx - h, cy - h, cz - h, cx + h, cy + h, cz + h];
    (positions, indices, aabb)
}

/// Build a session from `(cx, cy, cz, side)` cubes.
fn session_of_sized(cubes: &[(f32, f32, f32, f32)]) -> ClashSession {
    let mut positions: Vec<f32> = Vec::new();
    let mut pos_ranges: Vec<u32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut idx_ranges: Vec<u32> = Vec::new();
    let mut aabbs: Vec<f32> = Vec::new();
    for &(cx, cy, cz, side) in cubes {
        let (p, idx, ab) = sized_cube(cx, cy, cz, side);
        pos_ranges.push(positions.len() as u32);
        pos_ranges.push(p.len() as u32);
        idx_ranges.push(indices.len() as u32);
        idx_ranges.push(idx.len() as u32);
        positions.extend_from_slice(&p);
        indices.extend_from_slice(&idx);
        aabbs.extend_from_slice(&ab);
    }
    let mut session = ClashSession::new();
    session.ingest(&positions, &pos_ranges, &indices, &idx_ranges, &aabbs);
    session
}

/// A closed, CONCAVE L-shaped prism: footprint
/// `(0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2)` extruded z=0..1. The square
/// `[1,2]×[1,2]` is the notch — inside the AABB but OUTSIDE the solid.
fn l_prism() -> TriMesh {
    let positions: Vec<f64> = vec![
        // bottom (z=0): 0..5
        0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 2.0, 0.0, 0.0, 2.0, 0.0,
        // top (z=1): 6..11
        0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0, 0.0, 2.0, 1.0,
    ];
    let indices: Vec<u32> = vec![
        // bottom cap (fan from 0)
        0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, // top cap (fan from 6)
        6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11, // sides (one quad per footprint edge)
        0, 1, 7, 0, 7, 6, 1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8, 3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11,
        10, 5, 0, 6, 5, 6, 11,
    ];
    TriMesh::new(positions, indices)
}

const HARD: u8 = 0;
const CLEARANCE: u8 = 1;

#[test]
fn overlapping_cubes_hard() {
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (0.5, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "expected exactly one hard clash");
    let rec = &result.records[0];
    assert_eq!(rec.status, ClashStatus::Hard);
    assert!(rec.distance < 0.0, "penetration distance must be negative, got {}", rec.distance);
}

#[test]
fn separated_cubes_hard_none() {
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (2.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 0, "separated cubes are not a hard clash");
}

#[test]
fn separated_cubes_clearance_hit() {
    // Cubes at x=0 and x=2: faces at x=0.5 and x=1.5 -> gap 1.0.
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (2.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], CLEARANCE, 0.001, 1.5, false);
    assert_eq!(result.records.len(), 1, "clearance 1.5 should report the gap");
    let rec = &result.records[0];
    assert_eq!(rec.status, ClashStatus::Clearance);
    assert!((rec.distance - 1.0).abs() < 1e-6, "gap should be ~1.0, got {}", rec.distance);
}

#[test]
fn separated_cubes_clearance_miss() {
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (2.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], CLEARANCE, 0.001, 0.5, false);
    assert_eq!(result.records.len(), 0, "clearance 0.5 < gap 1.0 -> no record");
}

#[test]
fn touching_faces_no_touch_report() {
    // Cubes at x=0 and x=1: faces coincide at x=0.5 -> contact, not penetration.
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 0, "touch with report_touch=false -> none");
}

#[test]
fn touching_faces_with_touch_report() {
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, true);
    assert_eq!(result.records.len(), 1, "touch with report_touch=true -> one record");
    assert_eq!(result.records[0].status, ClashStatus::Touch);
}

#[test]
fn self_clash_group() {
    // Three cubes: two overlap, one is far away. group_b empty -> self-clash.
    let session = session_of_cubes(&[(0.0, 0.0, 0.0), (0.5, 0.0, 0.0), (10.0, 0.0, 0.0)]);
    let result = session.run_rule(&[0, 1, 2], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "only the overlapping pair clashes");
    let rec = &result.records[0];
    assert_eq!(rec.status, ClashStatus::Hard);
    // Records carry GLOBAL element indices; the overlapping pair is (0, 1).
    assert_eq!((rec.a, rec.b), (0, 1));
}

#[test]
fn enclosed_solid_hard() {
    // A side-1 cube fully inside a side-10 cube, both centred at origin: surfaces
    // are ~4.5 apart so no triangle pair is within margin — only full enclosure
    // signals the clash, via the point-in-solid ray cast.
    let session = session_of_sized(&[(0.0, 0.0, 0.0, 10.0), (0.0, 0.0, 0.0, 1.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "fully-enclosed solid must be a hard clash");
    assert_eq!(result.records[0].status, ClashStatus::Hard);
    assert!(result.records[0].distance < 0.0, "penetration distance must be negative");
}

#[test]
fn separated_not_enclosed_none() {
    // Two side-1 cubes far apart: neither AABB contains the other, so the
    // enclosure path must stay quiet (no false positive).
    let session = session_of_sized(&[(0.0, 0.0, 0.0, 1.0), (20.0, 0.0, 0.0, 1.0)]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 0, "disjoint cubes are not a clash");
}

#[test]
fn contains_point_convex_cube() {
    let (p, idx, _) = unit_cube(0.0, 0.0, 0.0);
    let positions: Vec<f64> = p.iter().map(|&x| x as f64).collect();
    let mesh = TriMesh::new(positions, idx);
    assert!(mesh.contains_point([0.0, 0.0, 0.0]), "centre is inside");
    assert!(!mesh.contains_point([5.0, 5.0, 5.0]), "far point is outside");
}

#[test]
fn contains_point_concave_notch_is_outside() {
    // The defining guarantee of ray casting over an AABB heuristic: a point in
    // the L-prism's concave notch is inside the AABB but OUTSIDE the solid.
    let mesh = l_prism();
    assert!(mesh.contains_point([0.5, 0.5, 0.5]), "point in the L arm is inside the solid");
    assert!(!mesh.contains_point([1.5, 1.5, 0.5]), "point in the concave notch is OUTSIDE the solid");
    assert!(!mesh.contains_point([5.0, 5.0, 5.0]), "far point is outside");
}

// --- Triangle math unit tests -------------------------------------------------

#[test]
fn tritri_intersect_piercing() {
    // Triangle A in the z=0 plane; triangle B pierces straight through it.
    let a0: Vec3 = [-1.0, -1.0, 0.0];
    let a1: Vec3 = [1.0, -1.0, 0.0];
    let a2: Vec3 = [0.0, 1.0, 0.0];
    let b0: Vec3 = [0.0, 0.0, -1.0];
    let b1: Vec3 = [0.0, 0.0, 1.0];
    let b2: Vec3 = [0.5, 0.5, 0.0];
    assert!(tri_tri_intersect(a0, a1, a2, b0, b1, b2), "piercing should intersect");
}

#[test]
fn tritri_intersect_separated() {
    let a0: Vec3 = [-1.0, -1.0, 0.0];
    let a1: Vec3 = [1.0, -1.0, 0.0];
    let a2: Vec3 = [0.0, 1.0, 0.0];
    // Same triangle translated +2 in z: clearly separated.
    let b0: Vec3 = [-1.0, -1.0, 2.0];
    let b1: Vec3 = [1.0, -1.0, 2.0];
    let b2: Vec3 = [0.0, 1.0, 2.0];
    assert!(!tri_tri_intersect(a0, a1, a2, b0, b1, b2), "separated should not intersect");
}

#[test]
fn tritri_intersect_coincident() {
    // Identical coplanar triangles: coplanar overlap is treated as touching,
    // i.e. NOT a hard intersection.
    let a0: Vec3 = [-1.0, -1.0, 0.0];
    let a1: Vec3 = [1.0, -1.0, 0.0];
    let a2: Vec3 = [0.0, 1.0, 0.0];
    assert!(!tri_tri_intersect(a0, a1, a2, a0, a1, a2), "coincident should not intersect");
}

#[test]
fn tritri_distance_parallel_gap() {
    let a0: Vec3 = [-1.0, -1.0, 0.0];
    let a1: Vec3 = [1.0, -1.0, 0.0];
    let a2: Vec3 = [0.0, 1.0, 0.0];
    // Same triangle, shifted +0.5 in z.
    let b0: Vec3 = [-1.0, -1.0, 0.5];
    let b1: Vec3 = [1.0, -1.0, 0.5];
    let b2: Vec3 = [0.0, 1.0, 0.5];
    let (dist, _, _) = tri_tri_distance(a0, a1, a2, b0, b1, b2);
    assert!((dist - 0.5).abs() < 1e-9, "parallel gap should be 0.5, got {dist}");
}

#[test]
fn tritri_distance_touching() {
    let a0: Vec3 = [-1.0, -1.0, 0.0];
    let a1: Vec3 = [1.0, -1.0, 0.0];
    let a2: Vec3 = [0.0, 1.0, 0.0];
    // Coplanar, sharing the vertex region -> distance ~0.
    let (dist, _, _) = tri_tri_distance(a0, a1, a2, a0, a1, a2);
    assert!(dist.abs() < 1e-9, "coincident triangles distance should be 0, got {dist}");
}
