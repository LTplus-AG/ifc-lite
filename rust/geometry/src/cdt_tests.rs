// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (the CDT). Split out of `cdt.rs` so the module-size
//! ratchet measures production code only, matching `extrusion_watertight_tests.rs`.

use super::*;

    fn pt(x: f64, y: f64) -> Point2<f64> {
        Point2::new(x, y)
    }

    fn area_of(points: &[Point2<f64>], idx: &[usize]) -> f64 {
        let mut a = 0.0;
        for t in idx.chunks_exact(3) {
            let p0 = points[t[0]];
            let p1 = points[t[1]];
            let p2 = points[t[2]];
            a += ((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)).abs() * 0.5;
        }
        a
    }

    /// Many-void CDT-cliff regression (advanced_model.ifc IFCSLAB #798926): the no-split
    /// (consolidate_coplanar) refinement of a many-hole slab face. The old
    /// rebuild-per-Steiner-point driver was O(P³) — 13.8 s in RELEASE for ONE
    /// 582-vertex/16-hole face, ×2 faces ×16 re-consolidates = a 155 s element.
    /// The incremental driver does the same face in ~10 ms. The shape below
    /// reproduces that face: a 134-vertex outer ring + 16 28-gon holes.
    ///
    /// Guards three things: (1) wall-time in release — bound 2 s, ~200× above
    /// the fixed cost, ~7× below the regressed cost, so scheduler jitter can't
    /// trip it but the O(P³) driver always does; (2) refinement actually ran
    /// (Steiner points were added); (3) the result is still area-exact and
    /// run-to-run deterministic (the incremental path must stay bit-stable).
    #[test]
    fn no_split_many_hole_refinement_is_fast_and_valid() {
        // Outer ring: 12 m × 10 m rectangle subdivided to 132 boundary verts.
        let (w, h, step) = (12.0_f64, 10.0_f64, 1.0 / 3.0);
        let mut outer: Vec<Point2<f64>> = Vec::new();
        let n_x = (w / step).round() as usize;
        let n_y = (h / step).round() as usize;
        for i in 0..n_x {
            outer.push(pt(i as f64 * step, 0.0));
        }
        for j in 0..n_y {
            outer.push(pt(w, j as f64 * step));
        }
        for i in (1..=n_x).rev() {
            outer.push(pt(i as f64 * step, h));
        }
        for j in (1..=n_y).rev() {
            outer.push(pt(0.0, j as f64 * step));
        }
        // 16 small 28-gon holes on a 4×4 grid (the slab's round penetrations).
        let mut holes: Vec<Vec<Point2<f64>>> = Vec::new();
        let r = 0.1_f64;
        for gx in 0..4 {
            for gy in 0..4 {
                let (cx, cy) = (1.5 + 3.0 * gx as f64, 2.0 + 2.0 * gy as f64);
                let ring: Vec<Point2<f64>> = (0..28)
                    .map(|k| {
                        let a = k as f64 / 28.0 * std::f64::consts::TAU;
                        pt(cx + r * a.cos(), cy + r * a.sin())
                    })
                    .collect();
                holes.push(ring);
            }
        }
        let n_input = outer.len() + holes.iter().map(|h| h.len()).sum::<usize>();

        let t0 = std::time::Instant::now();
        let (pts, idx) = triangulate_refined(&outer, &holes).expect("no-split refinement");
        let dt = t0.elapsed();

        // Refinement ran (Steiner points beyond the input rings) and the domain
        // is exact: outer area minus the 16 polygonal holes.
        assert!(
            pts.len() > n_input,
            "expected Steiner points (got {} verts for {n_input} inputs)",
            pts.len()
        );
        let hole_area: f64 = holes.iter().map(|h| {
            let mut s = 0.0;
            for i in 0..h.len() {
                let j = (i + 1) % h.len();
                s += h[i].x * h[j].y - h[j].x * h[i].y;
            }
            (s * 0.5).abs()
        }).sum();
        let area = area_of(&pts, &idx);
        let expected = 12.0 * 10.0 - hole_area;
        assert!(
            (area - expected).abs() < 1e-6,
            "area {area} != {expected} (outer minus 16 holes)"
        );
        // Bit-stable run-to-run (the incremental driver is deterministic).
        let (pts2, idx2) = triangulate_refined(&outer, &holes).unwrap();
        assert_eq!(idx, idx2, "index lists must be identical run-to-run");
        assert_eq!(pts.len(), pts2.len());
        for (a, b) in pts.iter().zip(pts2.iter()) {
            assert_eq!(a.x.to_bits(), b.x.to_bits());
            assert_eq!(a.y.to_bits(), b.y.to_bits());
        }
        // Perf bound — release only (debug predicate cost is ~10× and CI debug
        // boxes jitter; the regressed driver fails this by ~7× even on slow HW).
        #[cfg(not(debug_assertions))]
        assert!(
            dt < std::time::Duration::from_secs(2),
            "no-split many-hole refinement took {dt:?} — the O(P³) rebuild-per-point driver is back"
        );
        let _ = dt;
    }

    /// Structural validity over ALIVE triangles: (1) every undirected edge is
    /// shared by at most 2 alive triangles; (2) neighbour links are mutually
    /// consistent (`t.n[e] = u` across edge `{a,b}` ⇒ `u` is alive, has edge
    /// `{a,b}`, and links back to `t` across it); (3) no alive triangle has
    /// zero area.
    fn assert_structurally_valid(cdt: &Cdt) {
        let mut edge_count: BTreeMap<(usize, usize), u32> = BTreeMap::new();
        for ti in 0..cdt.tris.len() {
            let t = &cdt.tris[ti];
            if !t.alive {
                continue;
            }
            assert_ne!(
                orient(cdt.points[t.v[0]], cdt.points[t.v[1]], cdt.points[t.v[2]]),
                0,
                "alive triangle {ti} {:?} has zero area",
                t.v
            );
            for e in 0..3 {
                let a = t.v[e];
                let b = t.v[(e + 1) % 3];
                *edge_count.entry(ekey(a, b)).or_insert(0) += 1;
                let nb = t.n[e];
                if nb != NONE {
                    assert!(
                        cdt.tris[nb].alive,
                        "triangle {ti} edge {a}-{b} points at dead triangle {nb}"
                    );
                    let back = cdt.tris[nb].edge_of(a, b).unwrap_or_else(|| {
                        panic!("neighbour {nb} of triangle {ti} lacks edge {a}-{b}")
                    });
                    assert_eq!(
                        cdt.tris[nb].n[back], ti,
                        "adjacency {ti} <-> {nb} over edge {a}-{b} is not mutual"
                    );
                }
            }
        }
        for (&(a, b), &c) in &edge_count {
            assert!(c <= 2, "edge {a}-{b} is used by {c} alive triangles");
        }
    }

    /// A1 regression (T-junction on a shared NON-constraint edge): a point
    /// inserted EXACTLY on the diagonal of a unit square (the diagonal is a
    /// shared interior edge, NOT a constraint) must split BOTH incident
    /// triangles. The old empty-cavity fallback (`split_in_triangle`) skipped
    /// the degenerate child on the collinear edge and re-filled only one side:
    /// the far triangle kept its neighbour link to the dead parent and the new
    /// vertex was left hanging mid-edge — a T-junction with broken adjacency.
    #[test]
    fn on_shared_edge_insertion_splits_both_sides() {
        // Unit square, all 4 boundary edges constrained, diagonal free.
        let points: Vec<P2> = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let segments = vec![(0usize, 1usize), (1, 2), (2, 3), (3, 0)];
        let mut cdt = Cdt::build_from(points, &segments, 0).expect("square CDT");
        assert_structurally_valid(&cdt);

        // The square interior is triangulated by ONE of its diagonals.
        let (d0, d1) = if cdt.edge_exists(0, 2) { (0, 2) } else { (1, 3) };
        assert!(cdt.edge_exists(d0, d1), "expected a diagonal edge");

        // Splice the EXACT diagonal midpoint in as a Steiner-style vertex
        // (same index discipline as `insert_steiner`: below the super verts).
        let vi = cdt.super_base;
        cdt.points.insert(vi, [0.5, 0.5]);
        cdt.super_base += 1;
        cdt.n_real += 1;
        for t in &mut cdt.tris {
            for v in &mut t.v {
                if *v >= vi {
                    *v += 1;
                }
            }
        }
        // Internal insertion via the empty-cavity fallback at a triangle
        // incident to the diagonal — must split BOTH sides in lockstep.
        let start = (0..cdt.tris.len())
            .find(|&ti| cdt.tris[ti].alive && cdt.tris[ti].edge_of(d0, d1).is_some())
            .expect("a triangle incident to the diagonal");
        cdt.split_at(start, vi);

        // The midpoint must be a REAL shared vertex fanned on both sides of
        // the old diagonal: exactly 4 alive triangles reference it (all four
        // square edges are constraints, so legalization cannot flip further).
        let refs = (0..cdt.tris.len())
            .filter(|&ti| cdt.tris[ti].alive && cdt.tris[ti].v.contains(&vi))
            .count();
        assert_eq!(refs, 4, "midpoint must be fanned by 4 triangles (both sides), got {refs}");
        assert_structurally_valid(&cdt);
    }

    /// The unrefined constrained triangulation EXCLUDES hole interiors (returns
    /// only the material region) and adds no Steiner points — the properties the
    /// 2D opening-subtraction re-extrude relies on for a manifold, minimal cap.
    #[test]
    fn constrained_excludes_holes_no_steiner() {
        let outer = vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0)];
        let holes = vec![vec![pt(4.0, 4.0), pt(4.0, 6.0), pt(6.0, 6.0), pt(6.0, 4.0)]];
        let (pts, idx) = super::triangulate_constrained(&outer, &holes).unwrap();
        // No Steiner points: the vertex list is exactly outer ++ holes.
        assert_eq!(pts.len(), 8);
        // Material area = 100 − 4 (the hole is excluded).
        assert!((area_of(&pts, &idx) - 96.0).abs() < 1e-9);
    }
