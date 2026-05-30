// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Golden tests mirroring the TypeScript reference suite plus triangle-math
//! unit tests.

use crate::narrow::ClashStatus;
use crate::session::ClashSession;
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
