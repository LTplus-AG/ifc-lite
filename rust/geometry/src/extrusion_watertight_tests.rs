// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Watertightness tests for [`super::extrude_profile_watertight`] (the 2D
//! opening-subtraction re-extrude path, #1806). Split from `extrusion.rs`
//! inline tests to keep that module inside its size budget; `*_tests.rs`
//! files are ratchet-exempt.

use super::*;
use crate::profile::Profile2D;
use crate::test_support::open_edges;

/// Total area of the triangles lying on the plane `z ≈ z0` (a cap), summed
/// with |signed area| so it is winding-independent.
fn cap_area(m: &Mesh, z0: f32) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b], m.positions[b + 1], m.positions[b + 2]]
    };
    let mut a = 0.0;
    for t in m.indices.chunks_exact(3) {
        let (p, q, r) = (v(t[0]), v(t[1]), v(t[2]));
        if (p[2] - z0).abs() < 1e-3 && (q[2] - z0).abs() < 1e-3 && (r[2] - z0).abs() < 1e-3 {
            a += (((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) as f64).abs()
                * 0.5;
        }
    }
    a
}

/// The 2D opening-subtraction re-extrude must produce a WATERTIGHT solid even
/// for a many-hole profile — the case earcut hole-bridge slivers break (they
/// leave the cap non-manifold, then `clean_degenerate` cracks it). A 10×10
/// plate with a 4×4 grid of 0.4×0.4 through-holes, extruded 2 m: the CDT caps
/// close as a 2-manifold (every edge shared by two triangles) and each cap's
/// area equals outer − holes (the holes are genuinely cut, not filled).
#[test]
fn watertight_extrude_many_holes() {
    use nalgebra::Point2;
    let outer = vec![
        Point2::new(0.0, 0.0),
        Point2::new(10.0, 0.0),
        Point2::new(10.0, 10.0),
        Point2::new(0.0, 10.0),
    ];
    let mut profile = Profile2D::new(outer);
    let mut hole_area = 0.0;
    for i in 0..4 {
        for j in 0..4 {
            let (x, y) = (1.0 + i as f64 * 2.2, 1.0 + j as f64 * 2.2);
            // Clockwise hole (opposite the CCW outer).
            profile.add_hole(vec![
                Point2::new(x, y),
                Point2::new(x, y + 0.4),
                Point2::new(x + 0.4, y + 0.4),
                Point2::new(x + 0.4, y),
            ]);
            hole_area += 0.4 * 0.4;
        }
    }
    let depth = 2.0;
    let mesh = extrude_profile_watertight(&profile, depth, None).unwrap();
    assert_eq!(open_edges(&mesh), 0, "many-hole re-extrude must be a closed 2-manifold");
    let expect = 100.0 - hole_area;
    for (label, z) in [("bottom", 0.0f32), ("top", depth as f32)] {
        assert!(
            (cap_area(&mesh, z) - expect).abs() < 1e-3,
            "{label} cap area {} != expected {expect} (holes not cut?)",
            cap_area(&mesh, z)
        );
    }
}

/// #5313: a profile whose ring carries a vertex a few tens of nanometres off
/// the chord of its neighbours (a 7.46 mm arc of a 117 m circle, discretized
/// as A, M, C — `ifcopenshell/928-column.ifc` #107) must still extrude to a
/// closed solid AFTER the router's hygiene pass. Earcut emits the cap sliver
/// (A, C, M) and `clean_degenerate` drops it as sub-grid, while the side walls
/// keep the quads A-M and M-C; before the fix that left three open edges per
/// cap (a T-junction at M).
#[test]
fn near_collinear_profile_vertex_survives_hygiene_closed() {
    use nalgebra::Point2;
    // The arc's two chord ends and its midpoint, plus the rest of the
    // 600 x 600 mm column outline, in the column's profile frame.
    let (r, half) = (117.088_633_873_226_f64, 3.185e-5_f64);
    let arc = |t: f64| Point2::new(-0.050_313 + r * (t.sin()), 0.357_631 + r * (1.0 - t.cos()));
    let outer = vec![
        Point2::new(-0.401_487, -0.238_639),
        Point2::new(0.198_513, -0.238_639),
        Point2::new(0.198_513, 0.354_490),
        arc(-half), // A
        arc(0.0),   // M: ~5.9e-8 m off the chord A-C
        arc(half),  // C
        Point2::new(-0.401_487, 0.361_361),
    ];
    let sagitta = r * (1.0 - half.cos());
    assert!(sagitta < 1.0e-6, "fixture must sit below the hygiene grid (got {sagitta})");

    let mut mesh = extrude_profile(&Profile2D::new(outer), 4.0, None).unwrap();
    assert_eq!(open_edges(&mesh), 0, "raw extrusion is closed");
    mesh.clean_degenerate_watertight();
    assert_eq!(
        open_edges(&mesh),
        0,
        "hygiene must not open a T-junction at the near-collinear profile vertex"
    );
}

/// Directed edges (by exact position) left without their reverse: 0 iff the
/// surface is closed AND consistently wound.
fn unpaired_directed_edges(m: &Mesh) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b].to_bits(), m.positions[b + 1].to_bits(), m.positions[b + 2].to_bits()]
    };
    let mut edges: std::collections::HashMap<_, i64> = std::collections::HashMap::new();
    for t in m.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry((key(a), key(b))).or_insert(0) += 1;
            *edges.entry((key(b), key(a))).or_insert(0) -= 1;
        }
    }
    edges.values().filter(|&&c| c != 0).count()
}

fn signed_volume(m: &Mesh) -> f64 {
    let p = |i: u32| {
        let b = i as usize * 3;
        nalgebra::Vector3::new(m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64)
    };
    m.indices
        .chunks_exact(3)
        .map(|t| p(t[0]).dot(&p(t[1]).cross(&p(t[2]))) / 6.0)
        .sum()
}

/// #5410: a profile hole's side walls must be wound OUT of the solid (into the
/// void), like the caps and the outer walls, whichever way either ring is
/// authored. They used to be wound as if the hole were an outer boundary, so
/// the extruded body was closed but winding-inconsistent: the exact kernel
/// then read the walls of a void that an opening also cuts as solid-facing and
/// corrupted the host. The consistent solid's divergence volume is exactly
/// `(outer - hole) * depth`; the inverted one reported `outer + hole`.
#[test]
fn hole_walls_wind_with_the_solid_for_every_ring_winding_5410() {
    use nalgebra::Point2;
    let square = |lo: f64, hi: f64| {
        vec![Point2::new(lo, lo), Point2::new(hi, lo), Point2::new(hi, hi), Point2::new(lo, hi)]
    };
    // 24 vertices takes the smooth radial-normal path in `create_side_walls`.
    let circle = |r: f64| {
        (0..24)
            .map(|i| {
                let a = std::f64::consts::TAU * i as f64 / 24.0;
                Point2::new(5.0 + r * a.cos(), 5.0 + r * a.sin())
            })
            .collect::<Vec<_>>()
    };
    let signed_area = |ring: &[Point2<f64>]| {
        (0..ring.len())
            .map(|i| {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                a.x * b.y - b.x * a.y
            })
            .sum::<f64>()
            * 0.5
    };
    let depth = 2.0;
    for hole_shape in [square(3.5, 6.5), circle(2.0)] {
        for (outer_ccw, hole_ccw) in [(true, false), (true, true), (false, false), (false, true)] {
            let mut outer = square(0.0, 10.0);
            if !outer_ccw {
                outer.reverse();
            }
            let mut hole = hole_shape.clone();
            if (signed_area(&hole) > 0.0) != hole_ccw {
                hole.reverse();
            }
            let expected = (signed_area(&outer).abs() - signed_area(&hole).abs()) * depth;
            let mut profile = Profile2D::new(outer);
            profile.add_hole(hole.clone());
            let case = format!("outer ccw={outer_ccw} hole ccw={hole_ccw} hole verts={}", hole.len());

            let uniform = extrude_profile(&profile, depth, None).unwrap();
            let lofted = extrude_profile_lofted(&profile, &profile, depth, None).unwrap();
            for (path, mesh) in [("uniform", &uniform), ("lofted", &lofted)] {
                assert_eq!(
                    unpaired_directed_edges(mesh),
                    0,
                    "{path} ({case}): the extruded solid must be closed and consistently wound"
                );
                let volume = signed_volume(mesh);
                assert!(
                    (volume - expected).abs() < 1e-3,
                    "{path} ({case}): outward volume {volume} != (outer - hole) * depth = {expected}"
                );
            }

            // The hole-wall normals face into the void: toward the hole's centre.
            let (cx, cy) = (5.0f32, 5.0f32);
            let mut hole_wall_vertices = 0;
            for (p, n) in uniform.positions.chunks_exact(3).zip(uniform.normals.chunks_exact(3)) {
                let r = ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt();
                if n[2].abs() < 0.5 && r < 3.0 {
                    hole_wall_vertices += 1;
                    let toward_centre = (cx - p[0]) * n[0] + (cy - p[1]) * n[1];
                    assert!(toward_centre > 0.0, "uniform ({case}): hole-wall normal {n:?} at {p:?} faces the solid");
                }
            }
            assert!(hole_wall_vertices > 0, "uniform ({case}): no hole-wall vertices sampled");
        }
    }
}
