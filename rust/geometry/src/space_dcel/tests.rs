// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

    use super::*;

    /// Build a closed loop of `corners` (CCW), each edge tagged with one
    /// source element id (so we can assert provenance).
    fn loop_segments(corners: &[[f64; 2]], source_base: u32) -> Vec<InputSegment> {
        let n = corners.len();
        (0..n)
            .map(|i| InputSegment::new(corners[i], corners[(i + 1) % n], Some(source_base + i as u32)))
            .collect()
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn single_room_area_matches() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        let plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.room_count(), 1);
        let room = plate.rooms().next().unwrap();
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area {}", plate.face_area(room));
    }

    #[test]
    fn face_based_room_is_the_gap_between_wall_rects() {
        // A 4×3 room boxed by four 0.2 m-thick wall rectangles (they overlap at
        // the corners, as real walls do). The room is the GAP between them: net
        // (inner faces) = 3.8×2.8 = 10.64; axis (+½t) = 4×3 = 12; gross (+t) =
        // 4.2×3.2 = 13.44. Nodes sit on the axis = the true wall mid.
        let rects = vec![
            [[-0.1, -0.1], [4.1, -0.1], [4.1, 0.1], [-0.1, 0.1]], // bottom
            [[-0.1, 2.9], [4.1, 2.9], [4.1, 3.1], [-0.1, 3.1]],   // top
            [[-0.1, -0.1], [0.1, -0.1], [0.1, 3.1], [-0.1, 3.1]], // left
            [[3.9, -0.1], [4.1, -0.1], [4.1, 3.1], [3.9, 3.1]],   // right
        ];
        let plate = SpacePlate::build_from_wall_rects(&rects, BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "the gap between the four walls is the one room");
        let room = plate.rooms().next().unwrap();
        // The editable plate sits on the wall AXIS: the room outline IS the axis
        // (4×3 = 12), and net_outline recovers the inner (net) / outer (gross) faces.
        let axis = polygon_area(&plate.face_outline(room)).abs();
        assert!((axis - 12.0).abs() < 1e-6, "room outline is the wall axis (4×3=12), got {axis}");
        let net = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((net - 10.64).abs() < 1e-3, "net (inner faces) = 10.64, got {net}");
        let gross = polygon_area(&plate.net_outline(room, false)).abs();
        assert!((gross - 13.44).abs() < 1e-3, "gross (outer faces) = 13.44, got {gross}");
    }

    #[test]
    fn face_based_edits_preserve_room_classification() {
        // The 4-wall box → one gap room. `is_room` is set once at build and
        // carried through edits, so neither a drag nor a split can re-classify
        // wall-interior faces into phantom rooms — and a split yields TWO rooms.
        let rects = vec![
            [[-0.1, -0.1], [4.1, -0.1], [4.1, 0.1], [-0.1, 0.1]],
            [[-0.1, 2.9], [4.1, 2.9], [4.1, 3.1], [-0.1, 3.1]],
            [[-0.1, -0.1], [0.1, -0.1], [0.1, 3.1], [-0.1, 3.1]],
            [[3.9, -0.1], [4.1, -0.1], [4.1, 3.1], [3.9, 3.1]],
        ];
        let mut plate = SpacePlate::build_from_wall_rects(&rects, BuildOptions::default());
        assert_eq!(plate.room_count(), 1);
        // The plate sits on the wall axis, so the room corners are the axis corners
        // (0,0)…(4,3). Drag one inward — must NOT spawn a phantom room.
        let corner = plate.find_vertex([4.0, 3.0]);
        plate.drag_vertex(corner, 3.7, 2.7).expect("drag");
        assert_eq!(plate.room_count(), 1, "a drag must not spawn phantom rooms");
        // Cut the room across → two rooms (both halves inherit is_room; this was
        // the "can't cut a space in half" bug).
        let room = plate.rooms().next().unwrap();
        let a = plate.find_vertex([0.0, 0.0]);
        let b = plate.find_vertex([3.7, 2.7]);
        plate.split_face(room, a, b, None).expect("split");
        assert_eq!(plate.room_count(), 2, "a split produces two rooms");
    }

    /// Two rooms sharing a central wall — the canonical "shared edge"
    /// fixture. A vertical wall at x=4 splits a 8×3 box into two 4×3 rooms.
    fn two_room_plate() -> SpacePlate {
        let segs = vec![
            // outer box
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)),
            // shared central wall
            InputSegment::new([4.0, 0.0], [4.0, 3.0], Some(99)),
        ];
        SpacePlate::build(&segs, BuildOptions::default())
    }

    #[test]
    fn shared_wall_yields_two_rooms() {
        let plate = two_room_plate();
        assert_eq!(plate.room_count(), 2, "central wall splits the box into two rooms");
        let total: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!((total - 24.0).abs() < 1e-6, "areas sum to the box: {total}");
    }

    #[test]
    fn shared_wall_is_one_edge_with_a_twin_in_the_neighbour() {
        let plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        // Find the half-edge of room[0] whose twin sits in a different room.
        let mut found = false;
        for h in plate.face_half_edges(rooms[0]) {
            if let Some(nbr) = plate.neighbor_across(h) {
                if nbr != rooms[0] && !plate.faces[nbr.0 as usize].is_outer {
                    found = true;
                    // The shared wall carries source element 99 on BOTH sides.
                    assert_eq!(plate.half_edges[h.0 as usize].source_element, Some(99));
                    let twin = plate.half_edges[h.0 as usize].twin;
                    assert_eq!(plate.half_edges[twin.0 as usize].source_element, Some(99));
                }
            }
        }
        assert!(found, "the two rooms must share exactly one wall edge via twin()");
    }

    #[test]
    fn drag_shared_vertex_updates_both_rooms_in_one_call() {
        let mut plate = two_room_plate();
        // The shared wall's bottom endpoint is the snapped vertex at (4,0).
        // Find it, then slide it to x=5 — room A grows, room B shrinks, both
        // returned by the single drag call.
        let v = (0..plate.vertices.len())
            .map(|i| VertexId(i as u32))
            .find(|v| {
                let p = plate.vertices[v.0 as usize].pos;
                (p[0] - 4.0).abs() < 1e-9 && (p[1] - 0.0).abs() < 1e-9
            })
            .expect("shared bottom vertex at (4,0)");
        let patches = plate.drag_vertex(v, 5.0, 0.0).expect("drag");
        assert_eq!(patches.len(), 2, "both incident rooms come back from one drag");
        let total: f64 = patches.iter().map(|p| p.area).sum();
        // Trapezoids, but the plate area is conserved.
        assert!((total - 24.0).abs() < 1e-6, "total area conserved under drag: {total}");
        assert!(patches.iter().all(|p| p.simple), "both faces stay simple");
        // The areas actually diverged from 12/12.
        let areas: Vec<f64> = patches.iter().map(|p| p.area).collect();
        assert!((areas[0] - areas[1]).abs() > 1.0, "drag must make the rooms unequal: {areas:?}");
    }

    #[test]
    fn split_then_areas_sum_to_parent() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 200);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        let before = plate.face_area(room);
        // Split corner (0,0)→(4,4) diagonal.
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v44 = plate.find_vertex([4.0, 4.0]);
        let patches = plate.split_face(room, v00, v44, None).expect("split");
        assert_eq!(patches.len(), 2);
        assert_eq!(plate.room_count(), 2, "one room became two");
        let after: f64 = patches.iter().map(|p| p.area).sum();
        assert!((after - before).abs() < 1e-6, "split conserves area: {before} vs {after}");
        // Each child is ~half the 16 m² square = 8 m².
        for p in &patches {
            assert!((p.area - 8.0).abs() < 1e-6, "each half is 8 m²: {}", p.area);
            assert!(p.simple);
        }
    }

    #[test]
    fn split_rejects_degenerate_cuts() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 300);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v40 = plate.find_vertex([4.0, 0.0]);
        // Adjacent corners → zero-area sliver. Must reject.
        assert_eq!(plate.split_face(room, v00, v40, None), Err(EditError::DegenerateCut));
        // Same vertex twice.
        assert_eq!(plate.split_face(room, v00, v00, None), Err(EditError::DegenerateCut));
    }

    #[test]
    fn split_edge_adds_a_shared_node_without_changing_area() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let areas_before: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        let verts_before = plate.face_outline(rooms[0]).len();

        // The shared interior wall edge of room 0, and its midpoint.
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let a = plate.vertices[plate.half_edges[shared.0 as usize].origin.0 as usize].pos;
        let bvid = plate.half_edges[plate.half_edges[shared.0 as usize].twin.0 as usize].origin;
        let b = plate.vertices[bvid.0 as usize].pos;
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];

        let n = plate.split_edge(shared, mid[0], mid[1]).expect("split_edge");
        assert_eq!(plate.vertex_position(n), Some(mid), "node sits at the requested point");
        assert_eq!(plate.room_count(), 2, "edge split creates no new face");
        let areas_after: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        for (a0, a1) in areas_before.iter().zip(&areas_after) {
            assert!((a0 - a1).abs() < 1e-6, "areas unchanged on-segment: {a0} vs {a1}");
        }
        assert_eq!(plate.face_outline(rooms[0]).len(), verts_before + 1, "room 0 gained the node");
        assert!(
            plate.face_outline(rooms[1]).iter().any(|p| (p[0] - mid[0]).abs() < 1e-9 && (p[1] - mid[1]).abs() < 1e-9),
            "the neighbour room shares the new node",
        );
    }

    #[test]
    fn merge_undoes_a_shared_wall() {
        let mut plate = two_room_plate();
        assert_eq!(plate.room_count(), 2);
        // Find the interior shared edge.
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let patches = plate.merge_faces(shared).expect("merge");
        assert_eq!(patches.len(), 1, "merge returns the surviving room");
        assert_eq!(plate.room_count(), 1, "two rooms became one");
        assert!((patches[0].area - 24.0).abs() < 1e-6, "merged area = full box: {}", patches[0].area);
        assert!(patches[0].simple, "merged room is a clean rectangle");
    }

    #[test]
    fn merge_rejects_exterior_walls() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        // An edge whose twin is the exterior.
        let exterior_edge = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("an outer wall");
        assert_eq!(plate.merge_faces(exterior_edge), Err(EditError::BordersExterior));
    }

    #[test]
    fn offset_centrelines_close_into_a_clean_rectangle() {
        // An 8×8 room whose wall centrelines miss each corner by ~0.1 m (one
        // wall overshoots, the neighbour undershoots) — the real-world case
        // that produced trapezoids. Corner-snap must recover the exact
        // rectangle (area 64), not a skewed quad.
        let segs = vec![
            InputSegment::new([-0.1, 8.0], [8.1, 8.0], Some(1)), // top, overshoots both ends
            InputSegment::new([8.0, 7.9], [8.0, -0.1], Some(2)), // right, undershoots top
            InputSegment::new([8.1, 0.0], [-0.1, 0.0], Some(3)), // bottom
            InputSegment::new([0.0, 8.1], [0.0, 0.1], Some(4)),  // left, undershoots bottom
        ];
        let plate = SpacePlate::build(&segs, BuildOptions { snap_tolerance: 0.25, min_area: 0.5 });
        assert_eq!(plate.room_count(), 1, "the four offset walls close into one room");
        let room = plate.rooms().next().unwrap();
        assert!(
            (plate.face_area(room) - 64.0).abs() < 1e-6,
            "corners must snap to the line intersections → exact 8×8; got {}",
            plate.face_area(room),
        );
    }

    #[test]
    fn corner_snap_skips_distant_wall_extensions() {
        // A short wall's end (1.9, 0) sits near where a FAR wall's line (x=2,
        // y 3..8) would cross, but that wall is nowhere near — the corner-snap
        // must NOT pull the end onto the phantom (2, 0).
        let mut segs = vec![
            InputSegment::new([0.0, 0.0], [1.9, 0.0], None),
            InputSegment::new([2.0, 3.0], [2.0, 8.0], None),
        ];
        super::arrangement::snap_corners(&mut segs, 0.25);
        let e = segs[0].b;
        assert!(
            (e[0] - 1.9).abs() < 1e-9 && e[1].abs() < 1e-9,
            "end must stay put (no phantom snap to 2,0): {e:?}",
        );
    }

    #[test]
    fn t_junction_closes_a_room_without_shared_corners() {
        // Two rooms where the central wall's axis ends ON the outer walls'
        // interiors (no shared corner vertex) — the messy-IFC case the TS
        // detector's T-junction pass exists for. Central wall runs y=0..3 at
        // x=4 but its endpoints are at (4, 0.02) and (4, 2.98), i.e. they
        // don't coincide with the box corners; T-junction snap must still
        // close two rooms.
        let segs = vec![
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)),
            InputSegment::new([4.0, 0.02], [4.0, 2.98], Some(99)),
        ];
        let plate = SpacePlate::build(&segs, BuildOptions { snap_tolerance: 0.1, min_area: 0.5 });
        assert_eq!(plate.room_count(), 2, "T-junction snap should still yield two rooms");
    }

    #[test]
    fn queries_tolerate_invalid_face_ids() {
        // A stale/out-of-range face id from JS must not panic the wasm module.
        let plate = two_room_plate();
        let bogus = FaceId(99_999);
        assert_eq!(plate.face_area(bogus), 0.0);
        assert!(plate.face_outline(bogus).is_empty());
        assert!(plate.bounding_elements(bogus).is_empty());
    }

    #[test]
    fn clone_is_independent_for_undo_snapshots() {
        // The wasm handle's `duplicate()` clones the plate for undo/redo.
        // Editing the clone must NOT touch the original (and vice-versa) —
        // that independence is what makes the undo stack correct.
        let plate = two_room_plate();
        let snapshot = plate.clone();

        let mut edited = plate;
        // Collapse a room by merging across the shared wall on the edited copy.
        let rooms: Vec<FaceId> = edited.rooms().collect();
        let shared = edited
            .face_half_edges(rooms[0])
            .find(|h| {
                edited
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !edited.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        edited.merge_faces(shared).expect("merge");

        assert_eq!(edited.room_count(), 1, "edited copy merged to one room");
        assert_eq!(snapshot.room_count(), 2, "snapshot is untouched by the edit");
        let snap_total: f64 = snapshot.rooms().map(|f| snapshot.face_area(f)).sum();
        assert!((snap_total - 24.0).abs() < 1e-6, "snapshot geometry intact: {snap_total}");
    }

    #[test]
    fn provenance_distinguishes_walls_from_user_splits() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 500);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Every boundary edge of the derived room came from a real wall.
        for (_h, src) in plate.bounding_elements(room) {
            assert!(src.is_some(), "derived walls carry their source element");
        }
        // After a user split with source None, the new partition is unsourced.
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v44 = plate.find_vertex([4.0, 4.0]);
        plate.split_face(room, v00, v44, None).expect("split");
        let child = plate.rooms().next().unwrap();
        let unsourced = plate
            .bounding_elements(child)
            .iter()
            .filter(|(_, s)| s.is_none())
            .count();
        assert!(unsourced >= 1, "the user-drawn partition has no source element");
    }

    #[test]
    fn dissolve_is_the_inverse_of_split_edge() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let areas_before: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        let verts_before: Vec<usize> = rooms.iter().map(|f| plate.face_outline(*f).len()).collect();
        // Add a node mid-shared-wall, then dissolve it back out.
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let a = plate.vertices[plate.half_edges[shared.0 as usize].origin.0 as usize].pos;
        let bvid = plate.half_edges[plate.half_edges[shared.0 as usize].twin.0 as usize].origin;
        let b = plate.vertices[bvid.0 as usize].pos;
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        let n = plate.split_edge(shared, mid[0], mid[1]).expect("split_edge");
        assert_eq!(plate.face_outline(rooms[0]).len(), verts_before[0] + 1, "node added");

        let patches = plate.dissolve_vertex(n).expect("dissolve the node");
        assert_eq!(patches.len(), 2, "both rooms touching the welded wall come back");
        assert_eq!(plate.vertex_position(n), None, "the node is tombstoned");
        assert_eq!(plate.room_count(), 2, "no room added or lost");
        for (f, (a0, v0)) in rooms.iter().zip(areas_before.iter().zip(&verts_before)) {
            assert!((plate.face_area(*f) - a0).abs() < 1e-6, "area restored");
            assert_eq!(plate.face_outline(*f).len(), *v0, "vertex count restored");
        }
    }

    #[test]
    fn dissolve_corner_straightens_the_room() {
        // A 4×3 rectangle; dropping corner (0,0) leaves the triangle
        // (4,0)-(4,3)-(0,3) = 12 − 6 = 6 m².
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 400);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let v00 = plate.find_vertex([0.0, 0.0]);
        let patches = plate.dissolve_vertex(v00).expect("dissolve a convex corner");
        assert_eq!(plate.room_count(), 1);
        assert_eq!(patches.len(), 1, "one incident room (the other side is exterior)");
        assert!((patches[0].area - 6.0).abs() < 1e-6, "area = 6 m²: {}", patches[0].area);
        assert!(patches[0].simple, "the triangle stays simple");
        assert_eq!(plate.face_outline(patches[0].face).len(), 3, "now a triangle");
    }

    #[test]
    fn dissolve_rejects_a_wall_junction() {
        // (4,0) is where the central wall meets the bottom wall: degree 3.
        let mut plate = two_room_plate();
        let junction = plate.find_vertex([4.0, 0.0]);
        assert_eq!(plate.dissolve_vertex(junction), Err(EditError::VertexNotDissolvable));
    }

    #[test]
    fn dissolve_rejects_triangle_collapse() {
        // A triangle room: dropping any corner welds two already-adjacent
        // neighbours into a parallel edge → a digon. Reject.
        let segs = loop_segments(&[[0.0, 0.0], [4.0, 0.0], [0.0, 3.0]], 500);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "triangle is one room");
        let corner = plate.find_vertex([0.0, 0.0]);
        assert_eq!(plate.dissolve_vertex(corner), Err(EditError::DegenerateCut));
    }

    #[test]
    fn dissolve_rejects_a_stale_handle() {
        let mut plate = two_room_plate();
        assert_eq!(plate.dissolve_vertex(VertexId(9999)), Err(EditError::StaleHandle));
    }

    #[test]
    fn add_face_creates_a_room_on_an_empty_plate() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        assert_eq!(plate.room_count(), 0, "no walls → no rooms");
        let patch = plate.add_face(&rect(0.0, 0.0, 5.0, 4.0), None).expect("draw a room");
        assert_eq!(plate.room_count(), 1, "the drawn room exists");
        assert!((patch.area - 20.0).abs() < 1e-6, "area = 20 m²: {}", patch.area);
        assert!(patch.simple);
        assert!((plate.face_area(patch.face) - 20.0).abs() < 1e-6, "queryable like any room");
    }

    #[test]
    fn add_face_normalises_clockwise_winding() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        // CW ring (reverse of a rect): area must still come out correct.
        let cw = vec![[0.0, 0.0], [0.0, 4.0], [5.0, 4.0], [5.0, 0.0]];
        let patch = plate.add_face(&cw, Some(7)).expect("draw a CW room");
        assert!((patch.area - 20.0).abs() < 1e-6, "winding normalised: {}", patch.area);
        assert!(polygon_area(&patch.outline) > 0.0, "interior face winds CCW");
    }

    #[test]
    fn add_face_into_an_existing_plate_keeps_the_old_rooms() {
        let mut plate = two_room_plate();
        let before: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        plate.add_face(&rect(20.0, 20.0, 23.0, 22.0), None).expect("draw a third room"); // 3×2 = 6 m²
        assert_eq!(plate.room_count(), 3, "two original + one drawn");
        let total: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!((total - (before + 6.0)).abs() < 1e-6, "old rooms intact: {total} vs {}", before + 6.0);
    }

    #[test]
    fn add_face_rejects_bad_rings() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        // Too few points.
        assert_eq!(plate.add_face(&[[0.0, 0.0], [1.0, 0.0]], None), Err(EditError::InvalidPolygon));
        // Self-intersecting bow-tie.
        let bowtie = vec![[0.0, 0.0], [4.0, 4.0], [4.0, 0.0], [0.0, 4.0]];
        assert_eq!(plate.add_face(&bowtie, None), Err(EditError::InvalidPolygon));
        // Collinear (zero area).
        let line = vec![[0.0, 0.0], [2.0, 0.0], [4.0, 0.0]];
        assert_eq!(plate.add_face(&line, None), Err(EditError::InvalidPolygon));
        // Consecutive duplicate point (zero-length edge) — non-zero area, but a
        // degenerate edge that is_simple_polygon misses. Reachable via a
        // double-click that lands the final corner twice.
        let dup = vec![[0.0, 0.0], [0.0, 0.0], [4.0, 0.0], [4.0, 4.0]];
        assert_eq!(plate.add_face(&dup, None), Err(EditError::InvalidPolygon));
        // Repeated closing point (first == last) — the wrap-around case.
        let closed = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 0.0]];
        assert_eq!(plate.add_face(&closed, None), Err(EditError::InvalidPolygon));
    }

    // ───────────────── orphan removal + auto-cleanup ─────────────────

    /// rect(0,0,4,3) plus a spur wall poking out of the right wall's midpoint
    /// to (6, 1.5). The T-junction snap splits the right wall at (4,1.5), so
    /// the arrangement carries a degree-1 tip at (6,1.5) and a redundant
    /// collinear node at (4,1.5).
    fn spur_segs() -> Vec<InputSegment> {
        let mut s = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        s.push(InputSegment::new([4.0, 1.5], [6.0, 1.5], Some(200)));
        s
    }

    /// Build the spur plate WITHOUT the `build` auto-prune (via the raw
    /// `from_arrangement`) so the spur survives for the removal/prune tests.
    fn spur_plate_unpruned() -> SpacePlate {
        let arr = Arrangement::resolve(&spur_segs(), 0.1);
        SpacePlate::from_arrangement(arr, 0.5)
    }

    fn live_vertex_count(plate: &SpacePlate) -> usize {
        (0..plate.vertices.len()).filter(|&i| plate.vertices[i].alive).count()
    }

    #[test]
    fn spur_fixture_actually_has_a_spur() {
        let plate = spur_plate_unpruned();
        assert_eq!(plate.room_count(), 1, "the rectangle is still one room");
        let tip = plate.find_vertex([6.0, 1.5]);
        assert_eq!(plate.vertex_degree(tip), 1, "the spur end is a degree-1 tip");
        let junction = plate.find_vertex([4.0, 1.5]);
        assert_eq!(plate.vertex_degree(junction), 3, "the spur base is a T-junction");
    }

    /// Two spurs land on the interior of ONE spine at (3,0) and (7,0). Before the
    /// per-sweep-splits change (`break 'outer` -> `break`) this needed two passes
    /// (one split each); the change must still resolve BOTH T-junctions — the spine
    /// split into three, each base a degree-3 node. Guards the arrangement fixpoint.
    #[test]
    fn multiple_t_junctions_on_one_spine_all_resolve() {
        let segs = vec![
            InputSegment::new([0.0, 0.0], [10.0, 0.0], Some(1)),
            InputSegment::new([3.0, 0.0], [3.0, 2.0], Some(2)),
            InputSegment::new([7.0, 0.0], [7.0, 2.0], Some(3)),
        ];
        let plate = SpacePlate::from_arrangement(Arrangement::resolve(&segs, 0.1), 0.5);
        let j1 = plate.find_vertex([3.0, 0.0]);
        let j2 = plate.find_vertex([7.0, 0.0]);
        assert_eq!(plate.vertex_degree(j1), 3, "first T-junction not resolved");
        assert_eq!(plate.vertex_degree(j2), 3, "second T-junction not resolved");
    }

    #[test]
    fn remove_spur_edge_drops_the_tip_and_keeps_area() {
        let mut plate = spur_plate_unpruned();
        let area_before: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        let tip = plate.find_vertex([6.0, 1.5]);
        let spur_he = plate.outgoing_half_edges(tip).next().expect("tip has an outgoing he");
        plate.remove_spur_edge(spur_he).expect("remove the spur");
        assert_eq!(plate.vertex_position(tip), None, "the tip is tombstoned");
        assert_eq!(plate.room_count(), 1, "no room gained or lost");
        let area_after: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!(
            (area_before - area_after).abs() < 1e-6,
            "spur removal is area-neutral: {area_before} vs {area_after}",
        );
    }

    #[test]
    fn remove_spur_edge_rejects_a_non_tip_and_a_stale_handle() {
        let mut plate = spur_plate_unpruned();
        // Any room boundary edge has both ends at degree ≥ 2 → not a spur.
        let room = plate.rooms().next().unwrap();
        let non_spur = plate.face_half_edges(room).next().expect("a room edge");
        assert_eq!(plate.remove_spur_edge(non_spur), Err(EditError::VertexNotDissolvable));
        assert_eq!(plate.remove_spur_edge(HalfEdgeId(99_999)), Err(EditError::StaleHandle));
    }

    #[test]
    fn prune_orphans_removes_the_spur_and_dissolves_the_exposed_node() {
        let mut plate = spur_plate_unpruned();
        let room = plate.rooms().next().unwrap();
        assert!(
            plate.face_outline(room).len() >= 5,
            "unpruned room boundary carries the T-junction node",
        );
        let removed = plate.prune_orphans();
        assert!(removed >= 2, "pruned the spur edge + the now-collinear node: {removed}");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "back to a clean 4-corner rectangle");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area unchanged: {}", plate.face_area(room));
        assert_eq!(live_vertex_count(&plate), 4, "only the four corners survive");
    }

    #[test]
    fn prune_orphans_is_idempotent_and_a_noop_on_clean_plates() {
        // Clean by construction (build auto-prunes) → nothing to do.
        let mut clean = two_room_plate();
        assert_eq!(clean.prune_orphans(), 0, "a clean two-room plate prunes nothing");
        assert_eq!(clean.room_count(), 2);
        let total: f64 = clean.rooms().map(|f| clean.face_area(f)).sum();
        assert!((total - 24.0).abs() < 1e-6, "areas intact: {total}");
        // A second prune right after a real one finds nothing.
        let mut messy = spur_plate_unpruned();
        messy.prune_orphans();
        assert_eq!(messy.prune_orphans(), 0, "prune is idempotent");
    }

    #[test]
    fn prune_keeps_genuine_corners() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.prune_orphans(), 0, "a clean rectangle has nothing to prune");
        assert_eq!(
            plate.face_outline(plate.rooms().next().unwrap()).len(),
            4,
            "all four real corners are kept (not mistaken for collinear)",
        );
    }

    #[test]
    fn build_auto_prunes_spur_walls() {
        let plate = SpacePlate::build(&spur_segs(), BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "the spur doesn't create a phantom room");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "derived room is a clean rectangle, no spur stub");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area is the rectangle: {}", plate.face_area(room));
    }

    #[test]
    fn remove_edge_merges_two_real_rooms() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let patches = plate.remove_edge(shared).expect("remove the shared wall");
        assert_eq!(plate.room_count(), 1, "two rooms merged into one");
        let total: f64 = patches.iter().map(|p| p.area).sum();
        assert!((total - 24.0).abs() < 1e-6, "merged area = full box: {total}");
    }

    #[test]
    fn remove_edge_refuses_an_enclosing_wall() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let exterior_edge = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("an outer wall");
        assert_eq!(plate.remove_edge(exterior_edge), Err(EditError::BordersExterior));
    }

    #[test]
    fn remove_edge_deletes_a_bridge_and_cleans_orphans() {
        let mut plate = spur_plate_unpruned();
        let tip = plate.find_vertex([6.0, 1.5]);
        let spur = plate.outgoing_half_edges(tip).next().expect("spur he");
        // Both of the spur's half-edges sit in the same (exterior) face → bridge.
        let t = plate.half_edges[spur.0 as usize].twin;
        assert_eq!(
            plate.half_edges[spur.0 as usize].face,
            plate.half_edges[t.0 as usize].face,
            "the spur is a bridge (same face both sides)",
        );
        let patches = plate.remove_edge(spur).expect("remove the bridge/spur wall");
        assert!(patches.is_empty(), "a bridge in the exterior bounds no room");
        assert_eq!(plate.room_count(), 1, "the rectangle room survives");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "room cleaned back to a rectangle");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area unchanged: {}", plate.face_area(room));
    }

    #[test]
    fn remove_edge_rejects_a_stale_handle() {
        let mut plate = two_room_plate();
        assert_eq!(plate.remove_edge(HalfEdgeId(99_999)), Err(EditError::StaleHandle));
    }

    // ───────────────── net-area (wall-thickness offset) ─────────────────

    /// A closed loop with a uniform wall half-thickness on every edge.
    fn thick_loop(corners: &[[f64; 2]], base: u32, half: f64) -> Vec<InputSegment> {
        loop_segments(corners, base).into_iter().map(|s| s.with_half_thickness(half)).collect()
    }

    fn thick_two_room_plate(half: f64) -> SpacePlate {
        let segs = vec![
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)).with_half_thickness(half),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)).with_half_thickness(half),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)).with_half_thickness(half),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)).with_half_thickness(half),
            InputSegment::new([4.0, 0.0], [4.0, 3.0], Some(99)).with_half_thickness(half),
        ];
        SpacePlate::build(&segs, BuildOptions::default())
    }

    #[test]
    fn net_outline_insets_and_outsets_by_the_wall_half_thickness() {
        let plate = SpacePlate::build(&thick_loop(&rect(0.0, 0.0, 4.0, 3.0), 100, 0.25), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Inner: 0.25 in on every side → 3.5 × 2.5 = 8.75 m².
        let inner = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((inner - 8.75).abs() < 1e-6, "inset 0.25 all round = 8.75, got {inner}");
        // Outer: 0.25 out on every side → 4.5 × 3.5 = 15.75 m².
        let outer = polygon_area(&plate.net_outline(room, false)).abs();
        assert!((outer - 15.75).abs() < 1e-6, "outset 0.25 all round = 15.75, got {outer}");
    }

    #[test]
    fn net_outline_is_the_centreline_without_thickness() {
        // loop_segments leaves half_thickness at 0 → nothing to offset.
        let plate = SpacePlate::build(&loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.net_outline(room, true), plate.face_outline(room), "no thickness → unchanged");
        assert_eq!(plate.net_outline(room, false), plate.face_outline(room));
    }

    #[test]
    fn net_outline_pins_a_shared_wall_when_pushing_outward() {
        let plate = thick_two_room_plate(0.25);
        assert_eq!(plate.room_count(), 2);
        // The left room (centroid x < 4) shares the central wall at x = 4.
        let left = plate
            .rooms()
            .find(|f| {
                let o = plate.face_outline(*f);
                (o.iter().map(|p| p[0]).sum::<f64>() / o.len() as f64) < 4.0
            })
            .expect("a left room");
        let outer = plate.net_outline(left, false);
        let max_x = outer.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        let min_x = outer.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
        assert!((max_x - 4.0).abs() < 1e-6, "shared wall (x=4) is pinned outward, got {max_x}");
        assert!((min_x + 0.25).abs() < 1e-6, "the exterior wall pushes out to -0.25, got {min_x}");
    }

    #[test]
    fn net_outline_thickness_survives_an_edge_split() {
        let mut plate = SpacePlate::build(&thick_loop(&rect(0.0, 0.0, 4.0, 3.0), 100, 0.25), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Split the bottom edge (y = 0) at its midpoint; both halves keep 0.25.
        let bottom = plate
            .face_half_edges(room)
            .find(|h| {
                let a = plate.vertices[plate.half_edges[h.0 as usize].origin.0 as usize].pos;
                let b = plate.vertices[plate.dest(*h).0 as usize].pos;
                a[1].abs() < 1e-9 && b[1].abs() < 1e-9
            })
            .expect("the bottom edge");
        plate.split_edge(bottom, 2.0, 0.0).expect("split");
        let inner = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((inner - 8.75).abs() < 1e-6, "the split edge keeps its wall thickness: {inner}");
    }

    // Test-only helper.
    impl SpacePlate {
        fn find_vertex(&self, pt: [f64; 2]) -> VertexId {
            (0..self.vertices.len())
                .map(|i| VertexId(i as u32))
                .find(|v| {
                    let p = self.vertices[v.0 as usize].pos;
                    self.vertices[v.0 as usize].alive
                        && (p[0] - pt[0]).abs() < 1e-6
                        && (p[1] - pt[1]).abs() < 1e-6
                })
                .unwrap_or_else(|| panic!("no live vertex near {pt:?}"))
        }
    }
