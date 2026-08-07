// SPDX-License-Identifier: MPL-2.0
//! Unit tests for the pure HBJSON geometry predicates in `geom.rs` and the
//! interior-adjacency pass in `adjacency.rs`.
//!
//! Both modules had no tests at all: the only thing exercising them was the
//! end-to-end `duplex_exports_valid_room_model` fixture test, whose assertions
//! (face counts per room, coordinates within 1 km) hold under a mirrored frame,
//! a doubled area, or a widened orientation gate. Each test below names the
//! mutation it kills.
//!
//! A CHILD module of `geom` so it can reach that module's private predicates
//! (`segments_cross`, `collinear_overlap`) without widening their visibility.

use super::*;
use crate::adjacency::solve_adjacency;
use crate::hbjson::{Face, Face3D, Room};

fn unit_square_xy() -> Vec<[f64; 3]> {
    vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
    ]
}

#[test]
fn zup_rotates_y_up_into_z_up() {
    // Every HBJSON coordinate goes through this. Dropping the sign MIRRORS the
    // whole model — rooms and their floor/ceiling roles swap — yet leaves face
    // counts and coordinate magnitudes (all the fixture test checks) untouched.
    // Kills: `[p[0], -p[2], p[1]]` -> `[p[0], p[2], p[1]]`.
    assert_eq!(zup([1.0, 2.0, 3.0]), [1.0, -3.0, 2.0]);
    assert_eq!(zup([0.0, 0.0, 5.0]), [0.0, -5.0, 0.0]);
}

#[test]
fn xf_reads_the_transform_column_major() {
    // IFC entity transforms arrive column-major; reading them row-major
    // transposes every placement.
    // Kills: `t[col * 4 + r]` -> `t[r * 4 + col]`, and any swap WITHIN the
    // linear block, e.g. `c(1, 0)` -> `c(0, 1)`.
    //
    // The fixture must be a full affine, NOT diagonal + translation: `xf` reads
    // nine entries, and a diagonal fixture leaves four of them (t[1], t[2],
    // t[4], t[6]) at zero, so a row/col swap inside the linear block reads
    // zero either way and is invisible. The asserts below pin that property of
    // the FIXTURE so it cannot silently decay back to a diagonal.
    let mut t = [0.0f32; 16];
    t[0] = 2.0; // m00
    t[1] = 5.0; // m10
    t[2] = 11.0; // m20
    t[4] = 3.0; // m01
    t[5] = 7.0; // m11
    t[6] = 13.0; // m21
    t[10] = 1.0; // m22
    t[15] = 1.0;
    t[12] = 10.0; // translation x  (column 3, row 0)
    t[13] = 20.0; // translation y
    t[14] = 30.0; // translation z

    for idx in [0usize, 1, 2, 4, 5, 6, 12, 13, 14] {
        assert!(
            t[idx] != 0.0,
            "xf reads t[{idx}]; a zero entry hides a row/col swap"
        );
    }
    assert_ne!(
        t[1], t[4],
        "c(1,0) must differ from c(0,1) or the swap is invisible"
    );
    assert_ne!(
        t[2], t[4],
        "c(2,0) must differ from c(0,1) or the swap is invisible"
    );
    assert_ne!(
        t[2], t[1],
        "c(2,0) must differ from c(1,0) or the swap is invisible"
    );

    // Y-up: x = 2*1 + 3*2 + 10 = 18, y = 5*1 + 7*2 + 20 = 39, z = 11*1 + 13*2 + 30 = 67.
    // zup([18, 39, 67]) = [18, -67, 39].
    assert_eq!(xf(&t, 1.0, 2.0), [18.0, -67.0, 39.0]);
}

#[test]
fn polygon_area_is_half_the_newell_magnitude() {
    // Areas feed the degeneracy gate AND the adjacency congruence check, so a
    // constant factor is invisible to both (they compare like with like).
    // Kills: `0.5 * |newell|` -> `1.0 * |newell|`.
    assert!((polygon_area(&unit_square_xy()) - 1.0).abs() < 1e-12);
    let tri = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]];
    assert!(
        (polygon_area(&tri) - 3.0).abs() < 1e-12,
        "got {}",
        polygon_area(&tri)
    );
}

#[test]
fn newell_normal_is_unit_and_follows_the_winding() {
    let n = newell_normal(&unit_square_xy());
    assert!((n[2] - 1.0).abs() < 1e-12, "CCW in XY faces +Z, got {n:?}");
    let mut reversed = unit_square_xy();
    reversed.reverse();
    assert!((newell_normal(&reversed)[2] + 1.0).abs() < 1e-12);
    // Degenerate (collinear) rings return the zero vector, not NaN.
    assert_eq!(
        newell_normal(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]]),
        [0.0; 3]
    );
}

#[test]
fn clean_ring_merges_vertices_at_exactly_the_merge_distance() {
    // The merge distance is a CLOSED bound: a vertex exactly `merge` away is a
    // duplicate. Honeybee collapses anything inside that band to a non-manifold
    // edge, so keeping it is the failure this guard exists to prevent.
    // Kills: `dist(&p, q) > merge` -> `>= merge`.
    let ring = vec![[0.0, 0.0, 0.0], [0.5, 0.0, 0.0], [2.0, 0.0, 0.0]];
    assert_eq!(
        clean_ring(ring, 0.5),
        vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0]]
    );
}

#[test]
fn clean_ring_drops_the_duplicate_closing_vertex() {
    // Kills: removing the trailing `out.pop()`.
    let ring = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0],
    ];
    assert_eq!(clean_ring(ring, 0.01).len(), 3);
}

#[test]
fn face_ok_rejects_slivers_and_non_planar_rings() {
    let tol = 0.01;
    assert!(face_ok(&unit_square_xy(), tol));
    // Sliver: area below AREA_EPS.
    assert!(!face_ok(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1e-6, 0.0],
            [0.0, 1e-6, 0.0]
        ],
        tol
    ));
    // Non-planar: one corner lifted well past the tolerance.
    assert!(!face_ok(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 0.0]
        ],
        tol
    ));
}

#[test]
fn center_averages_over_the_actual_vertex_count() {
    // Kills: `b.len().max(1)` -> `.max(2)`.
    assert_eq!(center(&[[3.0, 6.0, 9.0]]), [3.0, 6.0, 9.0]);
    assert_eq!(center(&unit_square_xy()), [0.5, 0.5, 0.0]);
    assert_eq!(center(&[]), [0.0; 3]);
}

#[test]
fn segments_cross_requires_a_proper_crossing() {
    let a1 = (0.0, 0.0);
    let a2 = (2.0, 0.0);
    // Proper X crossing.
    assert!(segments_cross(a1, a2, (1.0, -1.0), (1.0, 1.0)));
    // T-junction: an endpoint sits ON the other segment. Topologically this is a
    // touch, not a crossing — the `d != 0.0` guards exist to say so, and without
    // them every shared-vertex footprint would be rejected as self-intersecting.
    // Kills: dropping `&& d1 != 0.0 && d2 != 0.0 && d3 != 0.0 && d4 != 0.0`.
    assert!(!segments_cross(a1, a2, (1.0, 0.0), (1.0, 1.0)));
    // Disjoint.
    assert!(!segments_cross(a1, a2, (5.0, -1.0), (5.0, 1.0)));
}

#[test]
fn collinear_overlap_tolerance_scales_with_the_edge_length() {
    // `dev = tol * len` is what makes `|orient2d| <= dev` mean "within `tol` of
    // the line" — orient2d is an AREA, so the band has to be scaled by the edge
    // length. A 100 m edge with a 5 mm offset is collinear at a 10 mm tolerance;
    // comparing the raw area against `tol` calls it non-collinear.
    // Kills: `let dev = tol * len;` -> `let dev = tol;`.
    assert!(collinear_overlap(
        (0.0, 0.0),
        (100.0, 0.0),
        (0.0, 0.005),
        (100.0, 0.005),
        0.01
    ));
    // Genuinely off the line at any scale.
    assert!(!collinear_overlap(
        (0.0, 0.0),
        (100.0, 0.0),
        (0.0, 5.0),
        (100.0, 5.0),
        0.01
    ));
    // Collinear but only touching at a point: not an overlap.
    assert!(!collinear_overlap(
        (0.0, 0.0),
        (1.0, 0.0),
        (1.0, 0.0),
        (2.0, 0.0),
        0.01
    ));
}

#[test]
fn is_simple_polygon_rejects_rings_with_fewer_than_three_vertices() {
    // A 2-vertex ring projects onto a degenerate segment, so every downstream
    // check silently passes it — only the explicit `m < 3` guard rejects it.
    // Kills: `if m < 3` -> `if m < 2`.
    assert!(!is_simple_polygon(
        &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
        0.01
    ));
    assert!(is_simple_polygon(&unit_square_xy(), 0.01));
}

#[test]
fn is_simple_polygon_rejects_bowties_and_pinches() {
    let tol = 0.01;
    // Self-crossing bowtie.
    assert!(!is_simple_polygon(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0]
        ],
        tol
    ));
    // Pinch: two non-adjacent vertices coincide.
    assert!(!is_simple_polygon(
        &[
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [2.0, 2.0, 0.0],
            [0.0, 2.0, 0.0],
            [1.0, 1.0, 0.0],
        ],
        tol
    ));
}

#[test]
fn is_watertight_requires_every_edge_shared_by_exactly_two_faces() {
    // A closed tetrahedron: every edge used twice.
    let (a, b, c, d) = (
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    );
    let tetra: Vec<(Vec<[f64; 3]>, &'static str)> = vec![
        (vec![a, b, c], "Floor"),
        (vec![a, c, d], "Wall"),
        (vec![a, d, b], "Wall"),
        (vec![b, d, c], "RoofCeiling"),
    ];
    assert!(is_watertight(&tetra, 0.01));

    // The same solid with one face duplicated twice: three of its edges are now
    // used FOUR times. That is non-manifold, and Honeybee rejects it — `== 2` is
    // load-bearing, `>= 2` would pass it.
    // Kills: `edges.values().all(|&c| c == 2)` -> `>= 2`.
    let mut doubled = tetra;
    doubled.push((vec![a, b, c], "Floor"));
    doubled.push((vec![a, b, c], "Floor"));
    assert!(!is_watertight(&doubled, 0.01));

    // Open box lid removed: naked edges.
    assert!(!is_watertight(&[(unit_square_xy(), "Floor")], 0.01));
    assert!(!is_watertight(&[], 0.01));
}

// ------------------------------------------------------------- adjacency

/// A 1x1 wall face in the plane `x = x0`. `facing_plus_x` picks the winding, so
/// the pair of walls this builds is genuinely anti-parallel.
fn wall_at_x(id: &str, x0: f64, facing_plus_x: bool) -> Face {
    let mut ring = vec![
        [x0, 0.0, 0.0],
        [x0, 1.0, 0.0],
        [x0, 1.0, 1.0],
        [x0, 0.0, 1.0],
    ];
    if !facing_plus_x {
        ring.reverse();
    }
    Face::new(id.to_string(), Face3D::new(ring), "Wall", "Outdoors")
}

/// A 1x1 floor face in the plane `z = 0` (normal +Z).
fn floor_face(id: &str) -> Face {
    Face::new(
        id.to_string(),
        Face3D::new(unit_square_xy()),
        "Floor",
        "Outdoors",
    )
}

fn adjacent_room_of(room: &Room, face: usize) -> Option<String> {
    room.faces[face]
        .boundary_condition
        .boundary_condition_objects
        .as_ref()
        .map(|o| o[1].clone())
}

#[test]
fn solve_adjacency_pairs_anti_parallel_walls_and_counts_both_faces() {
    // Two rooms separated by a 100 mm wall: the facing wall faces become a
    // reciprocal `Surface` pair. The return value counts FACES (2 per pair), which
    // is what the exporter reports as `interior_adjacencies`.
    // Kills: `pairs.len() * 2` -> `pairs.len()`.
    let mut rooms = vec![
        Room::new("A".into(), vec![wall_at_x("A-w", 0.0, true)]),
        Room::new("B".into(), vec![wall_at_x("B-w", 0.1, false)]),
    ];
    assert_eq!(
        solve_adjacency(&mut rooms),
        2,
        "one pair = two interior faces"
    );
    assert_eq!(rooms[0].faces[0].boundary_condition.ty, "Surface");
    assert_eq!(rooms[1].faces[0].boundary_condition.ty, "Surface");
    assert_eq!(adjacent_room_of(&rooms[0], 0).as_deref(), Some("B"));
    assert_eq!(adjacent_room_of(&rooms[1], 0).as_deref(), Some("A"));
}

#[test]
fn solve_adjacency_rejects_perpendicular_faces() {
    // A floor and a wall meeting at the same centroid clear every other gate
    // (gap 0, lateral 0, equal areas). Only the anti-parallel test rules them out,
    // and a widened gate would give the room an interior floor bounded by a wall.
    // Kills: `dot(a.n, b.n) > -0.95` -> `> 0.95`.
    let mut ring = unit_square_xy();
    for p in &mut ring {
        p[0] -= 0.5;
        p[1] -= 0.5;
    }
    let mut wall_ring = vec![
        [0.0, -0.5, -0.5],
        [0.0, 0.5, -0.5],
        [0.0, 0.5, 0.5],
        [0.0, -0.5, 0.5],
    ];
    wall_ring.reverse();
    let mut rooms = vec![
        Room::new(
            "A".into(),
            vec![Face::new(
                "A-f".into(),
                Face3D::new(ring),
                "Floor",
                "Outdoors",
            )],
        ),
        Room::new(
            "B".into(),
            vec![Face::new(
                "B-w".into(),
                Face3D::new(wall_ring),
                "Wall",
                "Outdoors",
            )],
        ),
    ];
    assert_eq!(
        solve_adjacency(&mut rooms),
        0,
        "perpendicular faces are not adjacent"
    );
    assert_eq!(rooms[0].faces[0].boundary_condition.ty, "Outdoors");
}

#[test]
fn solve_adjacency_picks_the_closest_valid_partner() {
    // Room A's wall has two anti-parallel, same-area candidates inside MAX_GAP:
    // room B across a 100 mm wall and room C across a 400 mm one. The near one is
    // the real neighbour; pairing the far one puts the heat flow between the wrong
    // two zones (and leaves B exterior).
    // Kills: `best.is_none_or(|(bg, _)| gap < bg)` -> `gap > bg`.
    let mut rooms = vec![
        Room::new("A".into(), vec![wall_at_x("A-w", 0.0, true)]),
        Room::new("B".into(), vec![wall_at_x("B-w", 0.1, false)]),
        Room::new("C".into(), vec![wall_at_x("C-w", 0.4, false)]),
    ];
    assert_eq!(solve_adjacency(&mut rooms), 2);
    assert_eq!(
        adjacent_room_of(&rooms[0], 0).as_deref(),
        Some("B"),
        "must pair with the nearest neighbour, not the farthest"
    );
    assert_eq!(rooms[2].faces[0].boundary_condition.ty, "Outdoors");
}

#[test]
fn solve_adjacency_ignores_faces_beyond_the_wall_thickness_budget() {
    // 2 m apart: two separate buildings, not a shared wall.
    let mut rooms = vec![
        Room::new("A".into(), vec![wall_at_x("A-w", 0.0, true)]),
        Room::new("B".into(), vec![wall_at_x("B-w", 2.0, false)]),
    ];
    assert_eq!(solve_adjacency(&mut rooms), 0);
    // ...and a degenerate face (fewer than 3 points) is skipped, not indexed.
    let mut degenerate = vec![
        Room::new(
            "A".into(),
            vec![Face::new(
                "A-d".into(),
                Face3D::new(vec![[0.0; 3], [1.0, 0.0, 0.0]]),
                "Wall",
                "Outdoors",
            )],
        ),
        Room::new("B".into(), vec![floor_face("B-f")]),
    ];
    assert_eq!(solve_adjacency(&mut degenerate), 0);
}
