// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

    use super::*;

    #[test]
    fn floor_pow2_is_exact_and_deterministic() {
        // Exact powers map to themselves; in-between rounds DOWN to the prev power.
        assert_eq!(floor_pow2(1.0), 1.0);
        assert_eq!(floor_pow2(2.0), 2.0);
        assert_eq!(floor_pow2(8.0), 8.0);
        assert_eq!(floor_pow2(1.9), 1.0);
        assert_eq!(floor_pow2(5.657), 4.0);
        assert_eq!(floor_pow2(0.2), 0.125);
        assert_eq!(floor_pow2(0.0), 0.0);
        assert_eq!(floor_pow2(-3.0), 0.0);
        // every result has exactly one set mantissa bit ⇒ bit-deterministic
        for x in [0.3_f64, 1.7, 3.0, 17.9, 1024.0, 1e-3, 1e6] {
            let p = floor_pow2(x);
            assert!(p > 0.0 && p <= x);
            assert_eq!(p.to_bits() & 0x000f_ffff_ffff_ffff, 0, "floor_pow2({x}) not a clean power of two");
        }
    }

    #[test]
    fn tri_is_needle_flags_slivers_hairline_for_their_own_span() {
        // The #1007 needle: 6.6 µm base, ~5 m apex span → drop.
        let needle = [
            Point3::new(4.672253608703613, -1.0, 12.385885238647461),
            Point3::new(1.047027587890625, -5.0, 14.07635498046875),
            Point3::new(4.672259330749512, -1.0, 12.385882377624512),
        ];
        assert!(tri_is_needle(&needle), "the #1007 diagonal sliver was not flagged");
        // A REAL thin sliver (0.2 m × 2 m face) must be KEPT.
        let real_thin = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
            Point3::new(2.0, 0.2, 0.0),
        ];
        assert!(!tri_is_needle(&real_thin), "a real 0.2×2 m sliver was wrongly flagged");
        // The documented cost of the scale-relative rule (#4698): the same
        // 5 mm width IS a needle once the span is 64 m, so a long plate edge
        // does not survive. Stated on `tri_is_needle`, pinned here.
        let long_plate_edge = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(64.0, 0.0, 0.0),
            Point3::new(64.0, 0.005, 0.0),
        ];
        assert!(tri_is_needle(&long_plate_edge), "a 64 m × 5 mm face is a needle by this rule");
        // A healthy near-equilateral triangle is kept.
        let healthy = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.5, 0.9, 0.0),
        ];
        assert!(!tri_is_needle(&healthy));
        // A fully-collapsed triangle (zero longest edge) is degenerate → drop.
        let collapsed = [Point3::new(1.0, 1.0, 1.0); 3];
        assert!(tri_is_needle(&collapsed));
    }

    #[test]
    fn weld_near_coincident_2d_collapses_um_rim_duplicates() {
        use nalgebra::Point2;
        // A unit-ish quad whose 4th corner is split into a 6.6 µm near-duplicate
        // (the rim-notch shape that earcut would otherwise frame as a needle).
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.9, 0.0),
            Point2::new(1.9, 1.0),
            Point2::new(0.000_006_6, 1.0),
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&ring);
        assert_eq!(welded.len(), 4, "near-coincident rim duplicate not welded: {welded:?}");
        // A ring with only genuine (≥0.2 m) edges is untouched.
        let clean = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 0.2),
            Point2::new(0.0, 0.2),
        ];
        assert_eq!(weld_near_coincident_2d(&clean).len(), 4, "a clean ring was over-welded");
    }

    #[test]
    fn weld_near_coincident_2d_keeps_mm_features_on_large_rings() {
        use nalgebra::Point2;
        // A 12 m × 1 m member face with a 1 mm corner chamfer (two vertices
        // 1 mm apart). Uncapped extent-relative eps (12/8192 ≈ 1.46 mm) would
        // weld the chamfer away; the absolute 2⁻¹² m cap must keep it.
        let chamfered = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 0.999),
            Point2::new(11.999, 1.0), // 1 mm chamfer edge
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&chamfered);
        assert_eq!(
            welded.len(),
            5,
            "1 mm chamfer on a 12 m ring was over-welded: {welded:?}"
        );
        // µm-scale rim duplicates must still weld on the SAME large ring.
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 1.0),
            Point2::new(0.000_02, 1.0), // 20 µm duplicate of the corner
            Point2::new(0.0, 1.0),
        ];
        assert_eq!(
            weld_near_coincident_2d(&ring).len(),
            4,
            "µm rim duplicate on a large ring not welded"
        );
    }


    #[test]
    fn merge_coplanar_collapses_subdivided_quad() {
        // Quad on z=0 plane split into 4 triangles via a centroid vertex.
        // consolidate_coplanar should reassemble it into a single quad and
        // triangulate that into 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        mesh.add_triangle(0, 1, 4);
        mesh.add_triangle(1, 2, 4);
        mesh.add_triangle(2, 3, 4);
        mesh.add_triangle(3, 0, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "consolidated quad should triangulate to 2 tris, got {}",
            consolidated.indices.len() / 3
        );
    }

    #[test]
    fn consolidate_preserves_local_frame_origin() {
        // Regression (#1806 void fast-path misplacement): `consolidate_coplanar`
        // rebuilds into a bare `Mesh::new()` whose `origin`/`rtc_applied`/#1474
        // capture default to zero. A LOCAL-FRAME host (origin != 0 — the wasm
        // default, and the frame the prism/coaxial void fast paths cut in) must
        // keep its per-element `origin` through the merge, or the whole cut host
        // is re-placed at the world origin (the AC20-FZK-Haus ground-floor walls
        // that floated ~6 m off the building). Uses the same subdivided quad the
        // merge test drives so consolidation genuinely runs (not the early
        // `return mesh` no-op path, which trivially preserves the frame).
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.0],
        ] {
            mesh.add_vertex(Point3::new(p[0], p[1], p[2]), Vector3::new(0.0, 0.0, 1.0));
        }
        mesh.add_triangle(0, 1, 4);
        mesh.add_triangle(1, 2, 4);
        mesh.add_triangle(2, 3, 4);
        mesh.add_triangle(3, 0, 4);
        mesh.origin = [11.85, 5.0, 1.35];
        mesh.rtc_applied = true;

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        // Sanity: consolidation actually ran (merged 4 tris -> 2), i.e. the
        // `output` path (not an early `return mesh`) produced this result.
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "test precondition: the mesh must consolidate so the rebuilt-output frame carry is exercised"
        );
        assert_eq!(
            consolidated.origin,
            [11.85, 5.0, 1.35],
            "consolidate_coplanar dropped the local-frame origin — the cut host would render at the world origin"
        );
        assert!(
            consolidated.rtc_applied,
            "consolidate_coplanar dropped rtc_applied"
        );
    }

    #[test]
    fn merge_coplanar_collapses_edge_split_quad() {
        // Quad whose boundary edge from (0,0) → (2,0) is split into three
        // segments by inserted collinear vertices (0.5, 0, 0) and
        // (1.5, 0, 0). Simulates a CSG kernel's "cutter crossed the host
        // edge here" fragment output. Must collapse back to 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [1.5, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        // Fan from corner 0 keeps everything CCW.
        mesh.add_triangle(0, 1, 5);
        mesh.add_triangle(1, 2, 5);
        mesh.add_triangle(2, 4, 5);
        mesh.add_triangle(2, 3, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "edge-split quad must collapse to 2 tris after collinear cleanup, got {}",
            consolidated.indices.len() / 3
        );
    }

    /// Build a watertight curved (arc-extruded) wall solid with `n` facets over a
    /// quarter turn, radius `r`, thickness `t`, height `h`. Each facet is its own
    /// plane bucket in `consolidate_coplanar` — the curved-wall seam case.
    fn curved_wall(n: usize, r: f64, t: f64, h: f64) -> Mesh {
        use std::f64::consts::PI;
        let mut m = Mesh::with_capacity(0, 0);
        let nrm = Vector3::new(0.0, 0.0, 0.0);
        let mut verts = Vec::new();
        for i in 0..=n {
            let a = (i as f64) / (n as f64) * (PI / 2.0);
            let (c, s) = (a.cos(), a.sin());
            verts.push(Point3::new(r * c, r * s, 0.0)); // 4i+0 O_bot
            verts.push(Point3::new(r * c, r * s, h)); //   4i+1 O_top
            verts.push(Point3::new((r - t) * c, (r - t) * s, 0.0)); // 4i+2 I_bot
            verts.push(Point3::new((r - t) * c, (r - t) * s, h)); //   4i+3 I_top
        }
        for p in &verts {
            m.add_vertex(*p, nrm);
        }
        let (ob, ot, ib, it) = (
            |i: usize| 4 * i as u32,
            |i: usize| 4 * i as u32 + 1,
            |i: usize| 4 * i as u32 + 2,
            |i: usize| 4 * i as u32 + 3,
        );
        let quad = |a: u32, b: u32, c: u32, d: u32, m: &mut Mesh| {
            m.add_triangle(a, b, c);
            m.add_triangle(a, c, d);
        };
        for i in 0..n {
            quad(ob(i), ob(i + 1), ot(i + 1), ot(i), &mut m); // outer
            quad(ib(i + 1), ib(i), it(i), it(i + 1), &mut m); // inner
            quad(ot(i), ot(i + 1), it(i + 1), it(i), &mut m); // top
            quad(ib(i), ib(i + 1), ob(i + 1), ob(i), &mut m); // bottom
        }
        quad(ob(0), ot(0), it(0), ib(0), &mut m); // cap @ a=0
        quad(ib(n), it(n), ot(n), ob(n), &mut m); // cap @ a=90
        m
    }

    fn axis_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let c = [
            Point3::new(lo[0], lo[1], lo[2]),
            Point3::new(hi[0], lo[1], lo[2]),
            Point3::new(hi[0], hi[1], lo[2]),
            Point3::new(lo[0], hi[1], lo[2]),
            Point3::new(lo[0], lo[1], hi[2]),
            Point3::new(hi[0], lo[1], hi[2]),
            Point3::new(hi[0], hi[1], hi[2]),
            Point3::new(lo[0], hi[1], hi[2]),
        ];
        for p in c.iter() {
            m.add_vertex(*p, n);
        }
        for tri in [
            [0u32, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
            [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
        ] {
            m.add_triangle(tri[0], tri[1], tri[2]);
        }
        m
    }

    /// Count open boundary edges (undirected edges whose directed half-edges do
    /// not pair forward+reverse) on a micron-snapped vertex topology — a watertight
    /// closed mesh has 0.
    fn count_open_edges(mesh: &Mesh) -> usize {
        use std::collections::HashMap;
        let q = |v: f32| (v as f64 * 1.0e6).round() as i64;
        let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
        let mut id = |i: usize| -> u32 {
            let k = (
                q(mesh.positions[i * 3]),
                q(mesh.positions[i * 3 + 1]),
                q(mesh.positions[i * 3 + 2]),
            );
            let n = vid.len() as u32;
            *vid.entry(k).or_insert(n)
        };
        let mut edge: HashMap<(u32, u32), i32> = HashMap::new();
        for tri in mesh.indices.chunks_exact(3) {
            let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
            for (x, y) in [(a, b), (b, c), (c, a)] {
                let (k, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
                *edge.entry(k).or_insert(0) += s;
            }
        }
        edge.values().filter(|&&v| v != 0).count()
    }

    #[test]
    fn curved_wall_opening_seam_is_watertight() {
        let host = curved_wall(8, 5.0, 0.3, 3.0); // 11.25°/facet
        assert_eq!(count_open_edges(&host), 0, "host must be watertight");
        // a window box straddling the arc around 30°..60°
        let cutter = axis_box([2.4, 2.4, 1.0], [4.4, 4.4, 2.0]);
        let raw = crate::kernel::mesh_bridge::subtract(&host, &cutter);
        let raw_open = count_open_edges(&raw);
        let consolidated = ClippingProcessor::consolidate_coplanar(raw.clone());
        let cons_open = count_open_edges(&consolidated);
        eprintln!(
            "SEAMTEST raw_tris={} raw_open={} cons_tris={} cons_open={}",
            raw.triangle_count(),
            raw_open,
            consolidated.triangle_count(),
            cons_open
        );
        assert_eq!(raw_open, 0, "raw kernel output must be watertight");
        assert_eq!(
            cons_open, 0,
            "consolidate must preserve the curved-wall opening seam (was torn)"
        );
    }
