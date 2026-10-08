// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #6940: a cutter that exactly fills an existing through-hole must leave
//! the host watertight and unchanged.
//!
//! The router extends an opening cutter past the host along the extrusion axis,
//! so its corners are no longer bit-identical host vertices (the exemption in
//! `promote_cutter_verts_onto_host_faces` for exact host vertices no longer
//! applies), but they still lie EXACTLY on the hole's own wall planes.
//! When ANOTHER host wall plane passes within the weld band of such a corner
//! (two holes whose walls are nearly collinear), the weld used to pull the
//! corner onto that other plane, which moved it off the hole's own wall planes.
//! The cutter wall then stopped being coplanar with the hole wall by a few
//! micrometres and the boolean tore the result open.
//!
//! Fixture-free: a slab with two holes extruded by the crate's own extruder and
//! an extended box cutter. No model, no ids.
//!
//! The opening goes through the pre-existing `ClippingProcessor::subtract_mesh`
//! entry point. General public kernel subtraction retains its operand weld;
//! its compatibility regression is in `kernel/mesh_bridge_tests.rs`.

use ifc_lite_geometry::ClippingProcessor;
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{extrude_profile, Mesh, Point2, Profile2D};
use std::collections::HashMap;

/// Directed-edge balance on a 1 mm position snap: every undirected edge must be
/// used exactly once in each direction. Returns the number of edges that are not.
fn open_edges(m: &Mesh) -> usize {
    type P = (i64, i64, i64);
    let q = |i: u32| {
        let p = &m.positions[i as usize * 3..i as usize * 3 + 3];
        let r = |v: f32| (v as f64 * 1.0e3).round() as i64;
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

#[test]
fn issue_6940_a_cutter_filling_a_hole_leaves_the_slab_watertight_and_unchanged() {
    // Skews of 1, 2, 3 grid steps (15, 31, 46 micrometres): all inside the weld
    // band (8 grid steps), none exactly on hole A's corner.
    for skew_steps in [1.0, 2.0, 3.0] {
        let host = slab_with_two_holes(skew_steps * G);
        assert_eq!(
            open_edges(&host),
            0,
            "skew {skew_steps}: the host itself must be watertight"
        );
        let host_volume = mesh_volume(&host);

        // The hole A footprint, in the host's own corner coordinates. The
        // cutter is pushed past both caps, as the router's extension does.
        let corners = [[1.0f32, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0]];
        for (z0, z1) in [(-0.1f32, 0.35f32), (-0.001, 0.251), (-0.25, 0.5)] {
            let cutter = box_cutter(corners, z0, z1);
            let cut = ClippingProcessor::new().subtract_mesh(&host, &cutter)
                .into_mesh().expect("opening cut produces a mesh");
            assert_eq!(
                open_edges(&cut),
                0,
                "skew {skew_steps}, cutter z [{z0}, {z1}]: a cutter filling an existing hole tore the slab open"
            );
            let dv = (mesh_volume(&cut) - host_volume).abs();
            assert!(
                dv < 1.0e-6,
                "skew {skew_steps}, cutter z [{z0}, {z1}]: the cutter is outside the solid, volume moved by {dv}"
            );
        }
    }
}
