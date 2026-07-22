// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Watertightness tests for [`super::extrude_profile_watertight`] (the 2D
//! opening-subtraction re-extrude path, #1806). Split from `extrusion.rs`
//! inline tests to keep that module inside its size budget; `*_tests.rs`
//! files are ratchet-exempt.

use super::*;
use crate::profile::Profile2D;

/// Count UNDIRECTED edges NOT shared by exactly two triangles — 0 on a closed
/// 2-manifold (the production watertightness contract, `param_cut_watertight`).
/// Vertices welded by exact f32 bits (coincident verts share bit patterns).
fn open_edges(m: &Mesh) -> usize {
    use std::collections::HashMap;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            m.positions[b].to_bits(),
            m.positions[b + 1].to_bits(),
            m.positions[b + 2].to_bits(),
        )
    };
    let mut edges: HashMap<_, u32> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(a), key(b));
            let e = if ka < kb { (ka, kb) } else { (kb, ka) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    edges.values().filter(|&&c| c != 2).count()
}

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
