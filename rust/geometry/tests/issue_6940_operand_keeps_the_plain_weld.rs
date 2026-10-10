// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #6940: the subtract-weld guard is for opening cutters only. The
//! second operand of an `IfcBooleanResult` DIFFERENCE keeps the weld it had.
//!
//! Split from `issue_6940_hole_wall_cutter_weld.rs`, whose slab and cutter it
//! repeats: this file calls `ClippingProcessor::subtract_operand`, which the
//! fix introduced, so it cannot compile without the fix. Kept apart, it does
//! not take the kernel reproduction down with it when the fix is reverted.

use ifc_lite_geometry::{extrude_profile, ClippingProcessor, Mesh, Point2, Profile2D};
use std::collections::HashMap;

/// Directed-edge balance on the 1/65536 m kernel grid: every undirected edge must be
/// used exactly once in each direction. Returns the number of edges that are not.
fn open_edges(m: &Mesh) -> usize {
    type P = (i64, i64, i64);
    let q = |i: u32| {
        let p = &m.positions[i as usize * 3..i as usize * 3 + 3];
        let r = |v: f32| (v as f64 / G).round() as i64;
        (r(p[0]), r(p[1]), r(p[2]))
    };
    let mut e: HashMap<(P, P), (u32, u32)> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let v = [q(t[0]), q(t[1]), q(t[2])];
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            if a == b {
                continue;
            }
            let (key, fwd) = if a < b {
                ((a, b), true)
            } else {
                ((b, a), false)
            };
            let s = e.entry(key).or_insert((0, 0));
            if fwd {
                s.0 += 1;
            } else {
                s.1 += 1;
            }
        }
    }
    e.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

/// Box cutter `[x0,x1] x [y0,y1] x [z0,z1]` with the corner order given, as
/// 12 outward triangles.
fn box_cutter(c: [[f32; 2]; 4], z0: f32, z1: f32) -> Mesh {
    let p = |a: [f32; 2], z: f32| [a[0], a[1], z];
    let mut tris: Vec<[[f32; 3]; 3]> = vec![
        [p(c[0], z1), p(c[1], z1), p(c[2], z1)],
        [p(c[0], z1), p(c[2], z1), p(c[3], z1)],
        [p(c[0], z0), p(c[2], z0), p(c[1], z0)],
        [p(c[0], z0), p(c[3], z0), p(c[2], z0)],
    ];
    for k in 0..4 {
        let n = (k + 1) % 4;
        tris.push([p(c[k], z0), p(c[n], z0), p(c[n], z1)]);
        tris.push([p(c[k], z0), p(c[n], z1), p(c[k], z1)]);
    }
    let mut m = Mesh::new();
    for t in &tris {
        let b = (m.positions.len() / 3) as u32;
        for v in t {
            m.positions.extend_from_slice(v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[b, b + 1, b + 2]);
    }
    m
}

/// A 1/65536 step: the kernel's snap grid, so every coordinate below is exactly
/// representable in f32 and survives the snap unchanged.
const G: f64 = 1.0 / 65536.0;

/// Slab `[0,8] x [0,8]`, depth 0.25, with two rectangular holes. Hole B's left
/// wall is a hair off collinear with hole A's left wall: it runs from
/// `(1, 3)` to `(1 + skew, 5)`, so its plane passes `skew` (micrometres) from
/// hole A's lower-left corner `(1, 1)`, inside the weld band but not on it.
fn slab_with_two_holes(skew: f64) -> Mesh {
    let pt = |x: f64, y: f64| Point2::new(x, y);
    let mut profile = Profile2D::new(vec![pt(0.0, 0.0), pt(8.0, 0.0), pt(8.0, 8.0), pt(0.0, 8.0)]);
    // Holes are clockwise.
    profile.add_hole(vec![pt(1.0, 1.0), pt(1.0, 2.0), pt(2.0, 2.0), pt(2.0, 1.0)]);
    profile.add_hole(vec![
        pt(1.0, 3.0),
        pt(1.0 + skew, 5.0),
        pt(2.0, 5.0),
        pt(2.0, 3.0),
    ]);
    extrude_profile(&profile, 0.25, None).expect("slab with two holes extrudes")
}

/// The guard is scoped to OPENING cutters. The second operand of an
/// `IfcBooleanResult` DIFFERENCE goes through `subtract_operand` and keeps the
/// weld it had before #6940, so on the same slab and cutter the two forms give
/// different meshes: the opening form closed, the operand form what the
/// unguarded weld produces.
#[test]
fn issue_6940_the_guard_is_for_opening_cutters_not_boolean_operands() {
    let host = slab_with_two_holes(2.0 * G);
    let cutter = box_cutter([[1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0]], -0.1, 0.35);
    let clipper = ClippingProcessor::new();
    let opening = clipper
        .subtract_mesh(&host, &cutter)
        .into_mesh()
        .expect("the opening form produces a mesh");
    let operand = clipper
        .subtract_operand(&host, &cutter)
        .into_mesh()
        .expect("the operand form produces a mesh");
    assert_eq!(
        open_edges(&opening),
        0,
        "the opening form must leave the slab closed"
    );
    assert_ne!(
        (&opening.positions, &opening.indices),
        (&operand.positions, &operand.indices),
        "the operand form took the guarded weld"
    );
}
