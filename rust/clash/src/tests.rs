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

/// Axis-aligned box with independent per-axis half-extents, centred at
/// `(cx, cy, cz)`. Same packing/winding as `unit_cube`. Used for the
/// perpendicular-bar crossing fixture (#1362 / #1402 Bug B).
fn box_hxyz(cx: f32, cy: f32, cz: f32, hx: f32, hy: f32, hz: f32) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let corners = [
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
    ];
    let mut positions = Vec::with_capacity(24);
    for c in &corners {
        positions.extend_from_slice(c);
    }
    let indices: Vec<u32> = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
        1, 5, 6, 1, 6, 2,
    ];
    let aabb = vec![cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz];
    (positions, indices, aabb)
}

/// A closed triangular prism: the `footprint` triangle (XY) extruded between
/// `z0` and `z1`. Exact-coordinate fixtures (no trig) so the slanted contact face
/// is bit-identically coplanar in `f32` and `f64`, exercising the coplanar-touch
/// fallback without the SAT degeneracy a rotated box would introduce (#1362 Bug A).
fn tri_prism(footprint: [[f32; 2]; 3], z0: f32, z1: f32) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let [p0, p1, p2] = footprint;
    // 0..2 bottom, 3..5 top.
    let v: [[f32; 3]; 6] = [
        [p0[0], p0[1], z0],
        [p1[0], p1[1], z0],
        [p2[0], p2[1], z0],
        [p0[0], p0[1], z1],
        [p1[0], p1[1], z1],
        [p2[0], p2[1], z1],
    ];
    let mut positions = Vec::with_capacity(18);
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in &v {
        positions.extend_from_slice(p);
        for axis in 0..3 {
            if p[axis] < min[axis] {
                min[axis] = p[axis];
            }
            if p[axis] > max[axis] {
                max[axis] = p[axis];
            }
        }
    }
    // bottom, top, then a quad (2 tris) per footprint edge.
    let indices: Vec<u32> = vec![
        0, 1, 2, // bottom
        3, 4, 5, // top
        0, 1, 4, 0, 4, 3, // edge p0-p1
        1, 2, 5, 1, 5, 4, // edge p1-p2 (the shared slanted face when reused)
        2, 0, 3, 2, 3, 5, // edge p2-p0
    ];
    let aabb = vec![min[0], min[1], min[2], max[0], max[1], max[2]];
    (positions, indices, aabb)
}

/// Build a session from already-built `(positions, indices, aabb)` parts.
fn session_of_parts(parts: &[(Vec<f32>, Vec<u32>, Vec<f32>)]) -> ClashSession {
    let mut positions: Vec<f32> = Vec::new();
    let mut pos_ranges: Vec<u32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut idx_ranges: Vec<u32> = Vec::new();
    let mut aabbs: Vec<f32> = Vec::new();
    for (p, idx, ab) in parts {
        pos_ranges.push(positions.len() as u32);
        pos_ranges.push(p.len() as u32);
        idx_ranges.push(indices.len() as u32);
        idx_ranges.push(idx.len() as u32);
        positions.extend_from_slice(p);
        indices.extend_from_slice(idx);
        aabbs.extend_from_slice(ab);
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
    // The coplanar/flush overlap must report the real (non-degenerate) overlap
    // region so it renders as a visible penetration box (#1402), not the zero-size
    // box of two near-coincident surface points. Overlap here is 0.5 x 1 x 1.
    let dx = rec.bounds[3] - rec.bounds[0];
    let dy = rec.bounds[4] - rec.bounds[1];
    let dz = rec.bounds[5] - rec.bounds[2];
    assert!(
        dx > 0.4 && dx < 0.6 && dy > 0.5 && dz > 0.5,
        "coplanar hard clash must report a visible overlap region, got {dx}x{dy}x{dz}"
    );
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

#[test]
fn skewed_face_touch_no_false_hard() {
    // Bug A (#1362): two members that only SHARE A SLANTED FACE (no shared volume)
    // still have fully-overlapping axis-aligned bounds because of the skew. The old
    // AABB-penetration proxy promoted that bare touch to a false hard clash; the
    // volumetric confirmation must suppress it.
    // A = lower-left wedge (x+y<=2); B = upper-right wedge sharing the hypotenuse.
    let a = tri_prism([[0.0, 0.0], [2.0, 0.0], [0.0, 2.0]], 0.0, 1.0);
    let b = tri_prism([[2.0, 0.0], [0.0, 2.0], [5.0, 5.0]], 0.0, 1.0);
    // Sanity: their AABBs overlap fully in A's footprint, so the broad phase pairs
    // them even though the solids only touch along the slanted face.
    let oa = &a.2;
    let ob = &b.2;
    let overlaps = oa[0] <= ob[3] && oa[3] >= ob[0] && oa[1] <= ob[4] && oa[4] >= ob[1];
    assert!(overlaps, "fixture invalid: AABBs must overlap to reach the narrow phase");

    let session = session_of_parts(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(
        result.records.len(),
        0,
        "a bare slanted-face touch with overlapping AABBs must NOT be a hard clash"
    );
}

#[test]
fn skewed_genuine_overlap_still_hard() {
    // Recall guard for Bug A: the SAME wedge A, but a box that genuinely straddles
    // the slanted face -> the fix must still report the hard clash (it suppresses
    // bare touches, not real overlaps).
    let a = tri_prism([[0.0, 0.0], [2.0, 0.0], [0.0, 2.0]], 0.0, 1.0);
    let b = box_hxyz(1.0, 1.0, 0.5, 0.5, 0.5, 0.5); // [0.5,1.5]^2 x [0,1], straddles x+y=2
    let session = session_of_parts(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "a genuine straddling overlap is a hard clash");
    assert_eq!(result.records[0].status, ClashStatus::Hard);
}

#[test]
fn aligned_unequal_overlap_still_hard() {
    // Bug A recall (PR #1455 review): two AXIS-ALIGNED members of unequal length
    // that genuinely overlap by a small amount, sharing y/z extents. The vertex-
    // centroid midpoint (~x=2.7) lies outside the shorter member, so a single
    // centroid probe would drop the clash; the AABB-overlap-centre probe keeps it.
    let a = box_hxyz(0.0, 0.0, 0.0, 5.0, 0.5, 0.5); // x[-5,5]
    let b = box_hxyz(5.4, 0.0, 0.0, 0.5, 0.5, 0.5); // x[4.9,5.9], overlaps x[4.9,5]
    let session = session_of_parts(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "a genuine aligned overlap is a hard clash");
    assert_eq!(result.records[0].status, ClashStatus::Hard);
}

#[test]
fn crossing_hard_bounds_are_tight() {
    // Bug B (#1362 / #1402): two perpendicular bars genuinely cross. The reported
    // contact bounds must be the LOCAL crossing region, not the whole-element AABB
    // overlap. Bar A runs along X, bar B along Y; they cross near the origin.
    let a = box_hxyz(0.0, 0.0, 0.0, 5.0, 0.5, 0.5); // x[-5,5]
    let b = box_hxyz(0.0, 0.0, 0.0, 0.5, 5.0, 0.5); // y[-5,5]
    let a_aabb = a.2.clone();
    let b_aabb = b.2.clone();
    let session = session_of_parts(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "crossing bars are a hard clash");
    let rec = &result.records[0];
    assert_eq!(rec.status, ClashStatus::Hard);

    // Tight along the long bar: A spans x[-5,5] (10 m), but the contact is only
    // the local crossing (~B's 1 m width), so the box must NOT span the whole bar.
    let bounds_x = rec.bounds[3] - rec.bounds[0];
    assert!(
        bounds_x < 2.0,
        "contact bounds must be local along the long bar, not its full length (got {bounds_x})"
    );

    // The tight bounds must stay inside the element-OVERLAP AABB on every axis,
    // not just element A: A is the long X bar, so an X regression returning most
    // of A's 10 m span would still satisfy an A-only check. The overlap is
    // x[-0.5,0.5] (B's width) on X.
    for axis in 0..3 {
        let overlap_min = a_aabb[axis].max(b_aabb[axis]) as f64;
        let overlap_max = a_aabb[axis + 3].min(b_aabb[axis + 3]) as f64;
        assert!(
            rec.bounds[axis] >= overlap_min - 1e-6 && rec.bounds[axis + 3] <= overlap_max + 1e-6,
            "contact bounds escape the element-overlap AABB on axis {axis}"
        );
    }
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
