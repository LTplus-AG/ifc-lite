// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

    use super::*;
    use super::geom::*;
    use crate::Mesh;

    /// AABB tuple in the shape `get_opening_item_bounds_with_direction` returns.
    fn aabb(
        min: (f64, f64, f64),
        max: (f64, f64, f64),
    ) -> (Point3<f64>, Point3<f64>, Option<Vector3<f64>>) {
        (
            Point3::new(min.0, min.1, min.2),
            Point3::new(max.0, max.1, max.2),
            None,
        )
    }

    #[test]
    fn spatial_clusters_separate_window_row_split_per_body() {
        // Issue #1367: a row of window voids under one IfcOpeningElement, each
        // separated by a solid pillar -> one cluster per body (subtract per item).
        let boxes: Vec<_> = (0..4)
            .map(|i| {
                let x0 = i as f64 * 2.0;
                aabb((x0, 0.0, 0.0), (x0 + 1.0, 0.3, 1.9))
            })
            .collect();
        assert_eq!(spatial_cluster_count(&boxes), 4);
    }

    #[test]
    fn spatial_clusters_touching_wall_leaf_halves_stay_merged() {
        // FZK-Haus: one window void split into adjacent inner/outer wall-leaf
        // halves (same X/Z footprint, abutting in Y) -> a single cluster (keep
        // merged, so the gable watertightness guard is not regressed).
        let inner = aabb((0.0, 0.0, 0.0), (1.0, 0.485, 0.9));
        let outer = aabb((0.0, 0.485, 0.0), (1.0, 0.9, 0.9));
        assert_eq!(spatial_cluster_count(&[inner, outer]), 1);
    }

    #[test]
    fn spatial_clusters_single_or_empty() {
        assert_eq!(spatial_cluster_count(&[]), 0);
        assert_eq!(
            spatial_cluster_count(&[aabb((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))]),
            1
        );
    }

    fn make_framed_box_mesh(
        origin: Point3<f64>,
        depth_axis: Vector3<f64>,
        cross_a: Vector3<f64>,
        cross_b: Vector3<f64>,
        depth: (f64, f64),
        a: (f64, f64),
        b: (f64, f64),
    ) -> Mesh {
        let point =
            |d: f64, av: f64, bv: f64| origin + depth_axis * d + cross_a * av + cross_b * bv;

        let corners = [
            point(depth.0, a.0, b.0),
            point(depth.1, a.0, b.0),
            point(depth.1, a.1, b.0),
            point(depth.0, a.1, b.0),
            point(depth.0, a.0, b.1),
            point(depth.1, a.0, b.1),
            point(depth.1, a.1, b.1),
            point(depth.0, a.1, b.1),
        ];

        let mut m = Mesh::with_capacity(24, 36);
        let faces: [[usize; 4]; 6] = [
            // Parity-sweep fix: [0, 2, 1, 3] was a crossed (bowtie) quad —
            // see `synthesis::make_box_mesh` for the full rationale.
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [0, 4, 7, 3],
            [1, 2, 6, 5],
        ];

        for idx in &faces {
            let edge1 = corners[idx[1]] - corners[idx[0]];
            let edge2 = corners[idx[2]] - corners[idx[0]];
            let normal = edge1
                .cross(&edge2)
                .try_normalize(1e-10)
                .unwrap_or(Vector3::new(0.0, 0.0, 1.0));
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], normal);
            m.add_vertex(corners[idx[1]], normal);
            m.add_vertex(corners[idx[2]], normal);
            m.add_vertex(corners[idx[3]], normal);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }

        m
    }

    /// Build a Z-extruded L-shaped prism. The six vertical walls share the
    /// same ±X/±Y normals as a box but sit at three different X (or Y)
    /// offsets, so a box detector that only counts axes would misclassify it.
    fn make_l_shape_prism_mesh() -> Mesh {
        // Footprint corners CCW in XY plane:
        // (0,0) -> (4,0) -> (4,2) -> (2,2) -> (2,4) -> (0,4) -> back to (0,0)
        let z0 = 0.0;
        let z1 = 1.0;
        let footprint = [
            (0.0_f64, 0.0_f64),
            (4.0, 0.0),
            (4.0, 2.0),
            (2.0, 2.0),
            (2.0, 4.0),
            (0.0, 4.0),
        ];

        let mut m = Mesh::new();
        let n = footprint.len();

        // Vertical walls — each footprint edge becomes one rectangular face.
        for i in 0..n {
            let (x0, y0) = footprint[i];
            let (x1, y1) = footprint[(i + 1) % n];
            let edge = Vector3::new(x1 - x0, y1 - y0, 0.0);
            let z_up = Vector3::new(0.0, 0.0, 1.0);
            let normal = edge
                .cross(&z_up)
                .try_normalize(1e-10)
                .unwrap_or(Vector3::new(1.0, 0.0, 0.0));
            let p0 = Point3::new(x0, y0, z0);
            let p1 = Point3::new(x1, y1, z0);
            let p2 = Point3::new(x1, y1, z1);
            let p3 = Point3::new(x0, y0, z1);
            let b = m.vertex_count() as u32;
            m.add_vertex(p0, normal);
            m.add_vertex(p1, normal);
            m.add_vertex(p2, normal);
            m.add_vertex(p3, normal);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }

        // Caps: fan-triangulate the L footprint at top and bottom.
        let bottom_n = Vector3::new(0.0, 0.0, -1.0);
        let top_n = Vector3::new(0.0, 0.0, 1.0);
        let bottom_base = m.vertex_count() as u32;
        for &(x, y) in &footprint {
            m.add_vertex(Point3::new(x, y, z0), bottom_n);
        }
        let top_base = m.vertex_count() as u32;
        for &(x, y) in &footprint {
            m.add_vertex(Point3::new(x, y, z1), top_n);
        }
        for i in 1..(n as u32 - 1) {
            // Bottom cap winds clockwise so its normal points -Z.
            m.add_triangle(bottom_base, bottom_base + i + 1, bottom_base + i);
            m.add_triangle(top_base, top_base + i, top_base + i + 1);
        }

        m
    }

    #[test]
    fn test_rectangular_box_detector_accepts_clean_box() {
        let opening = make_framed_box_mesh(
            Point3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
            (-0.15, 0.15),
            (-1.0, 1.0),
            (0.0, 2.0),
        );
        assert!(is_rectangular_box_mesh(&opening));
    }

    #[test]
    fn test_rectangular_box_detector_rejects_l_shape() {
        // An L-shaped vertical shaft has only three face-normal axes
        // (±X, ±Y, ±Z) — the same as a box — but its ±X / ±Y walls sit at
        // three different offsets. Without a per-axis plane-count check the
        // detector would misclassify it as a box and the rectangular cutter
        // would over-cut the AABB of the L.
        let opening = make_l_shape_prism_mesh();
        assert!(
            !is_rectangular_box_mesh(&opening),
            "rectilinear non-box footprints must fall through to NonRectangular CSG"
        );
    }

    /// Regression for #547: a trapezoid extrusion has exactly 3 face-normal
    /// axes after anti-parallel merging (front/back, top/bottom, and the two
    /// slanted sides which merge into one axis), but two of those axes are
    /// not perpendicular. Without an orthogonality check the detector would
    /// classify it as a box and the AABB cutter would over-cut the host wall.
    #[test]
    fn test_rectangular_box_detector_rejects_trapezoid_extrusion() {
        // Trapezoid extruded along +Y: narrow at z=0 (x ∈ [-0.3, 0.3]),
        // wide at z=2 (x ∈ [-0.5, 0.5]), thickness 0.6 in y.
        let mut positions: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let push_v = |positions: &mut Vec<f32>, x: f32, y: f32, z: f32| {
            positions.extend_from_slice(&[x, y, z]);
        };
        // 8 corners: 4 of trapezoid at y=0, 4 at y=0.6.
        // Order: bl, br, tr, tl on each face (b=bottom narrow, t=top wide).
        push_v(&mut positions, -0.3, 0.0, 0.0); // 0
        push_v(&mut positions, 0.3, 0.0, 0.0); // 1
        push_v(&mut positions, 0.5, 0.0, 2.0); // 2
        push_v(&mut positions, -0.5, 0.0, 2.0); // 3
        push_v(&mut positions, -0.3, 0.6, 0.0); // 4
        push_v(&mut positions, 0.3, 0.6, 0.0); // 5
        push_v(&mut positions, 0.5, 0.6, 2.0); // 6
        push_v(&mut positions, -0.5, 0.6, 2.0); // 7
        // Front (y=0): 0,1,2 + 0,2,3
        indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        // Back (y=0.6): 5,4,7 + 5,7,6
        indices.extend_from_slice(&[5, 4, 7, 5, 7, 6]);
        // Bottom narrow (z=0): 4,5,1 + 4,1,0
        indices.extend_from_slice(&[4, 5, 1, 4, 1, 0]);
        // Top wide (z=2): 3,2,6 + 3,6,7
        indices.extend_from_slice(&[3, 2, 6, 3, 6, 7]);
        // Right slanted: 1,5,6 + 1,6,2
        indices.extend_from_slice(&[1, 5, 6, 1, 6, 2]);
        // Left slanted: 4,0,3 + 4,3,7
        indices.extend_from_slice(&[4, 0, 3, 4, 3, 7]);

        let mut mesh = Mesh::new();
        mesh.positions = positions;
        mesh.indices = indices;
        assert!(
            !is_rectangular_box_mesh(&mesh),
            "trapezoid extrusion must be rejected — its slanted-side axis is \
             not perpendicular to the top/bottom axis, so the AABB cutter would \
             over-cut the host"
        );
    }

    /// A box rotated 45° around Z should still be classified as a box: its
    /// three face-normal axes are mutually orthogonal even though none align
    /// with world axes. The diagonal cutter then handles the rotation.
    #[test]
    fn test_rectangular_box_detector_accepts_rotated_box() {
        let opening = make_framed_box_mesh(
            Point3::new(0.0, 0.0, 0.0),
            Vector3::new(0.7071067811865476, 0.7071067811865476, 0.0),
            Vector3::new(-0.7071067811865476, 0.7071067811865476, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
            (-0.15, 0.15),
            (-1.0, 1.0),
            (0.0, 2.0),
        );
        assert!(
            is_rectangular_box_mesh(&opening),
            "axis-rotated boxes must still be detected — rotation alone does \
             not make them non-rectangular"
        );
    }

    #[test]
    fn test_infers_sloped_brep_opening_frame() {
        // Roof openings exported as BReps do not expose an extrusion direction.
        // The frame must be inferred from the box faces so reveal generation
        // preserves the roof pitch/roll instead of falling back to world axes.
        let depth_axis = Vector3::new(0.0, -0.5, 0.8660254037844386);
        let cross_a = Vector3::new(1.0, 0.0, 0.0);
        let cross_b = depth_axis.cross(&cross_a).normalize();
        let opening = make_framed_box_mesh(
            Point3::new(10.0, 20.0, 5.0),
            depth_axis,
            cross_a,
            cross_b,
            (-0.2, 0.2),
            (-0.8, 0.8),
            (-0.4, 0.4),
        );

        let frame = infer_opening_frame(&opening, None).unwrap();

        assert!(
            frame.depth.dot(&depth_axis).abs() > 0.99,
            "shortest inferred axis should be the sloped roof-window depth"
        );
        assert!(
            frame.cross_a.dot(&cross_a).abs() > 0.99 || frame.cross_b.dot(&cross_a).abs() > 0.99,
            "inferred frame should preserve the opening roll axis"
        );
        assert!(
            !frame.is_axis_aligned(),
            "sloped BRep opening should use the diagonal frame path"
        );
    }

    #[test]
    fn test_perpendicular_corner_openings_do_not_merge() {
        // Issue #1337: FreeCAD/brep openings carry no extrusion direction
        // (dir = None). A window on one wall and a garage-door opening on the
        // PERPENDICULAR wall have AABBs that cross at the building corner —
        // overlapping on all three axes but coinciding on NONE. Collapsing them
        // into one bounding box punches a phantom hole through both walls (the
        // reported corner over-cut). They must stay separate.
        let window = OpeningType::Rectangular(
            Point3::new(1.5, -1.2, 0.9),
            Point3::new(2.7, 1.2, 2.1),
            None,
        );
        let door = OpeningType::Rectangular(
            Point3::new(-2.4, 0.55, 0.0),
            Point3::new(2.4, 2.95, 2.2),
            None,
        );
        let merged = GeometryRouter::merge_rectangular_openings(&[window, door]);
        assert_eq!(
            merged.len(),
            2,
            "perpendicular corner openings (overlap-all-axes, coincide-none) must not merge"
        );
    }

    #[test]
    fn test_deep_box_opening_penetration_axis_is_transversal() {
        // Issue #1337 follow-up: a FreeCAD window cutter is a box 1.2 wide (x),
        // 2.4 DEEP (y, through-wall), 1.2 tall (z). Its thinnest axis is x/z, but
        // it penetrates along y — it pokes past the host's y-bounds. The depth
        // axis for the through-host cap-flush extension must be y, else the push
        // runs vertically and latches onto a neighbouring void's reveal facet
        // (all windows share z[0.9,2.1]), over-cutting the wall.
        let dir = infer_box_penetration_dir(
            &Point3::new(1.5, -1.2, 0.9),
            &Point3::new(2.7, 1.2, 2.1),
            &Point3::new(0.0, 0.0, 0.0),
            &Point3::new(8.4, 6.2, 3.93),
        );
        assert!(dir.y.abs() > 0.99, "deep cutter penetrates along y, got {dir:?}");
    }

    #[test]
    fn test_flush_box_opening_falls_back_to_thinnest_axis() {
        // A flush cutter sized to the wall thickness sits inside the host on
        // every axis -> classic thinnest-axis (the wall normal). Unchanged.
        let dir = infer_box_penetration_dir(
            &Point3::new(1.5, 0.0, 0.9),
            &Point3::new(2.7, 0.4, 2.1),
            &Point3::new(0.0, 0.0, 0.0),
            &Point3::new(8.4, 6.2, 3.93),
        );
        assert!(dir.y.abs() > 0.99, "flush cutter -> thinnest (y), got {dir:?}");
    }

    #[test]
    fn test_aligned_stacked_openings_still_merge() {
        // The merge still collapses the O(2^N) case it exists for: openings that
        // tile a wall coincide on two axes per pair (here X and Y) and are
        // adjacent on the third (Z), so bbox(A,B) == A ∪ B with no phantom volume.
        let lower = OpeningType::Rectangular(
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.4, 1.0),
            None,
        );
        let upper = OpeningType::Rectangular(
            Point3::new(1.0, 0.0, 1.0),
            Point3::new(2.0, 0.4, 2.0),
            None,
        );
        let merged = GeometryRouter::merge_rectangular_openings(&[lower, upper]);
        assert_eq!(merged.len(), 1, "aligned stacked openings should still merge");
        match &merged[0] {
            OpeningType::Rectangular(mn, mx, _) => {
                assert!(mn.z.abs() < 1e-9 && (mx.z - 2.0).abs() < 1e-9, "merged Z span");
            }
            _ => panic!("expected a merged Rectangular opening"),
        }
    }

    #[test]
    fn test_extend_opening_pads_past_wall_on_exact_match() {
        // Regression test for issue #604: when an opening's depth exactly matches
        // its wall's depth along the extrusion axis, the extended bounds must NOT
        // sit exactly on the wall faces — that produces 0-thickness CSG/clip
        // artifacts. The extension should always overshoot the wall slightly.
        let router = crate::router::GeometryRouter::new();

        // Wall: 0.2 m thick along Y
        let wall_min = Point3::new(0.0, 0.0, 0.0);
        let wall_max = Point3::new(10.0, 0.2, 3.0);
        // Opening exactly fills the wall in Y (0.0..0.2) — the failing case
        let open_min = Point3::new(4.0, 0.0, 1.0);
        let open_max = Point3::new(6.0, 0.2, 2.5);
        let dir = Vector3::new(0.0, 1.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        // Both faces must overshoot the wall, not sit exactly on it
        assert!(
            new_min.y < wall_min.y,
            "extended opening min Y {} must be strictly below wall min Y {}",
            new_min.y,
            wall_min.y,
        );
        assert!(
            new_max.y > wall_max.y,
            "extended opening max Y {} must be strictly above wall max Y {}",
            new_max.y,
            wall_max.y,
        );
        // Padding must stay imperceptibly small (<< 1 mm for a 0.2 m wall)
        let back_pad = wall_min.y - new_min.y;
        let fwd_pad = new_max.y - wall_max.y;
        assert!(back_pad > 0.0 && back_pad < 1e-3);
        assert!(fwd_pad > 0.0 && fwd_pad < 1e-3);
        // Cross-axis bounds untouched
        assert_eq!(new_min.x, open_min.x);
        assert_eq!(new_max.x, open_max.x);
        assert_eq!(new_min.z, open_min.z);
        assert_eq!(new_max.z, open_max.z);
    }

    #[test]
    fn test_extend_opening_skipped_when_opening_pokes_past_wall() {
        // Regression for issue #832: a 1×1×0.2 m opening offset so its
        // 0.2 m extrusion depth pokes 0.1 m past the wall's +X face. The
        // Revit "extend to reach the opposite wall face" heuristic would
        // stretch the opening through the wall thickness and the AABB
        // clip would remove BOTH the +X (touched) and -X (un-touched)
        // wall faces — the "punched-through slot" the user reported.
        // The extension must bail out and return the authored bounds.
        let router = crate::router::GeometryRouter::new();

        // Wall: 0.2 m thick along X, 3 m × 3 m face.
        let wall_min = Point3::new(7.9, 0.0, 0.0);
        let wall_max = Point3::new(8.1, 3.0, 3.0);
        // Opening starts inside the wall (x=8.0) and pokes past +X (x=8.2).
        let open_min = Point3::new(8.0, 0.5, 1.0);
        let open_max = Point3::new(8.2, 1.5, 2.0);
        let dir = Vector3::new(1.0, 0.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        // Authored bounds must come back UNCHANGED — no extension, no pad.
        assert_eq!(new_min, open_min, "X-poke-out: extension must not change min");
        assert_eq!(new_max, open_max, "X-poke-out: extension must not change max");

        // Same shape mirrored: opening pokes past -X face, extrusion -X.
        let wall_min = Point3::new(5.9, 0.0, 0.0);
        let wall_max = Point3::new(6.1, 3.0, 3.0);
        let open_min = Point3::new(5.8, 0.5, 1.0);
        let open_max = Point3::new(6.0, 1.5, 2.0);
        let dir = Vector3::new(-1.0, 0.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        assert_eq!(new_min, open_min, "-X-poke-out: extension must not change min");
        assert_eq!(new_max, open_max, "-X-poke-out: extension must not change max");
    }

    /// DETERMINISM (CI-safe, no fixture): the parametric cut on a rotated, building-scale
    /// wall must FIRE, be watertight, emit a local-frame mesh (small positions + origin),
    /// and produce BIT-IDENTICAL output across runs. Bit-identical-across-runs + the
    /// FMA-free f64 arithmetic (`rotate_point`, snap grid) is the native==wasm contract:
    /// every operation is a deterministic f64 op with a single f32 store, so the two
    /// targets cannot diverge.
    #[test]
    fn param_cut_is_deterministic_watertight_and_local_framed() {
        let router = GeometryRouter::new();
        // 37° about Z, right-handed frame (cross_b = depth × cross_a).
        let yaw = 37.0_f64.to_radians();
        let (c, s) = (yaw.cos(), yaw.sin());
        let cross_a = Vector3::new(c, s, 0.0); // wall length axis
        let depth = Vector3::new(-s, c, 0.0); // wall thickness axis
        let cross_b = depth.cross(&cross_a); // wall height axis
        // The cut path sees RTC-rebased (small) coordinates — a national-grid model is
        // re-based to near origin before meshing, so the host f32 mesh is precise. (An
        // un-rebased building-scale mesh correctly FAILS host reconciliation and defers.)
        let center = Point3::new(3.0, 2.0, 5.0);

        // World rotated wall: 4 m (cross_a) × 3 m (cross_b) × 0.3 m thick (depth).
        let host_world = make_framed_box_mesh(
            center, depth, cross_a, cross_b, (-0.15, 0.15), (-2.0, 2.0), (-1.5, 1.5),
        );
        let host = RectParam {
            r: Matrix3::from_columns(&[cross_a, cross_b, depth]),
            center,
            half: [2.0, 1.5, 0.15],
        };
        // A centred window, over-spanning the thickness (through-cut) and well within
        // the wall in-face — fires all the gates.
        let opening = RectParam {
            r: host.r,
            center,
            half: [0.5, 0.5, 0.25],
        };
        let ctx = VoidContext {
            openings: Vec::new(),
            merged_openings: Vec::new(),
            param: Some(ParamRectCut {
                host,
                openings: vec![opening],
            }),
            bool2d: None,
        };

        let out1 = router
            .try_param_rect_cut(&host_world, &ctx)
            .expect("parametric cut must fire on a clean rotated wall");
        let out2 = router
            .try_param_rect_cut(&host_world, &ctx)
            .expect("parametric cut must fire on a clean rotated wall");

        // Bit-identical across runs (⇒ native==wasm by the FMA-free construction).
        assert_eq!(out1.positions, out2.positions, "positions must be deterministic");
        assert_eq!(out1.indices, out2.indices, "indices must be deterministic");
        assert_eq!(out1.normals, out2.normals, "normals must be deterministic");
        assert_eq!(out1.origin, out2.origin, "origin must be deterministic");

        // Local-frame output: origin = wall centre, positions stay SMALL (near 0) so the
        // f32 store survives at national-grid magnitude.
        assert_eq!(out1.origin, [center.x, center.y, center.z]);
        let max_abs = out1
            .positions
            .iter()
            .fold(0.0f32, |m, &v| m.max(v.abs()));
        assert!(max_abs < 10.0, "local-frame positions must stay small (got {max_abs})");

        assert!(param_cut_watertight(&out1), "cut must be watertight");
        assert!(out1.triangle_count() > 12, "the opening must add faces");
    }
