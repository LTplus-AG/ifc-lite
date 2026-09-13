// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Round-26 mutation-audit fixture for a never-mutated magic constant in this
//! file: `drop_faces_outside_host`'s `VERTEX_CLEARANCE` (1.0e-3, absolute). It
//! had zero unit-level coverage before that round, only exercised
//! transitively through full IFC-fixture integration tests, which never probed
//! the boundary magnitude. Also `mesh_to_keep`'s three arms (#4692).

use super::*;
use crate::csg::GroupReject;
use crate::Vector3;

/// `mesh_to_keep` keeps a `Cut` even at the host's triangle count (the #4692
/// fix), keeps a re-tessellated miss only when its count moved, and keeps
/// nothing for a rejection. The re-tessellation arm is what the geometry
/// census depends on and the census does not run on PRs: dropping it (keeping
/// the original host for every miss) regressed 25 or more census hosts.
#[test]
fn mesh_to_keep_keeps_a_cut_and_a_count_changing_retessellation_4692() {
    let host = box_mesh((0.0, 0.0, 0.0), (1.0, 1.0, 1.0));
    let mut regrown = host.clone();
    regrown.merge(&needle_and_anchor(0.0));

    let kept = |outcome| mesh_to_keep(outcome, &host).map(|m| m.triangle_count());
    assert_eq!(kept(GroupCut::Cut(host.clone())), Some(12), "a cut at the host's count is still a cut");
    assert_eq!(kept(GroupCut::Retessellated(regrown.clone())), Some(14), "a count-changing miss is kept");
    assert_eq!(kept(GroupCut::Retessellated(host.clone())), None, "a same-count miss leaves the host");
    assert_eq!(kept(GroupCut::Rejected(GroupReject::GateRejected)), None, "a rejection leaves the host");
}

/// Axis-aligned box mesh, outward-wound, `min`..`max`. Volume is exactly
/// `(max-min).x * (max-min).y * (max-min).z` (up to f32 rounding).
fn box_mesh(min: (f64, f64, f64), max: (f64, f64, f64)) -> Mesh {
    let c = |x: f64, y: f64, z: f64| Point3::new(x, y, z);
    let corners = [
        c(min.0, min.1, min.2), // 0
        c(max.0, min.1, min.2), // 1
        c(max.0, max.1, min.2), // 2
        c(min.0, max.1, min.2), // 3
        c(min.0, min.1, max.2), // 4
        c(max.0, min.1, max.2), // 5
        c(max.0, max.1, max.2), // 6
        c(min.0, max.1, max.2), // 7
    ];
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], // bottom, -z
        [4, 5, 6, 7], // top, +z
        [0, 1, 5, 4], // front, -y
        [2, 3, 7, 6], // back, +y
        [0, 4, 7, 3], // left, -x
        [1, 2, 6, 5], // right, +x
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for idx in &faces {
        let e1 = corners[idx[1]] - corners[idx[0]];
        let e2 = corners[idx[2]] - corners[idx[0]];
        let n = e1
            .cross(&e2)
            .try_normalize(1e-10)
            .unwrap_or(Vector3::new(0.0, 0.0, 1.0));
        let b = m.vertex_count() as u32;
        m.add_vertex(corners[idx[0]], n);
        m.add_vertex(corners[idx[1]], n);
        m.add_vertex(corners[idx[2]], n);
        m.add_vertex(corners[idx[3]], n);
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// Two triangles: a "needle" triangle with two vertices deep inside the
/// host box and one vertex poking out through the `x = 1` face by exactly
/// `poke`, plus a wholly-interior "anchor" triangle that must never be
/// dropped (keeps `dropped != tri_count`, avoiding the all-dropped bailout).
fn needle_and_anchor(poke: f64) -> Mesh {
    let mut m = Mesh::with_capacity(6, 6);
    // Needle: two interior points near the x=1 face, one point poking out.
    let n = Vector3::new(0.0, 0.0, 1.0);
    m.add_vertex(Point3::new(0.5, 0.5, 0.5), n);
    m.add_vertex(Point3::new(0.5, 0.5, 0.6), n);
    m.add_vertex(Point3::new(1.0 + poke, 0.5, 0.5), n);
    m.add_triangle(0, 1, 2);
    // Anchor: comfortably inside the box, far from any face.
    m.add_vertex(Point3::new(0.2, 0.2, 0.2), n);
    m.add_vertex(Point3::new(0.3, 0.2, 0.2), n);
    m.add_vertex(Point3::new(0.2, 0.3, 0.2), n);
    m.add_triangle(3, 4, 5);
    m
}

#[test]
fn drop_faces_outside_host_vertex_clearance_boundary_is_1e_3() {
    let host = box_mesh((0.0, 0.0, 0.0), (1.0, 1.0, 1.0));

    // Poke = 0.0009 < VERTEX_CLEARANCE (1e-3): the stray vertex is within
    // clearance of the host's x=1 face, so the needle triangle is KEPT ->
    // both triangles survive.
    let kept = needle_and_anchor(0.0009);
    let kept_tris_before = kept.triangle_count();
    let out_kept = drop_faces_outside_host(kept, &host);
    assert_eq!(
        out_kept.triangle_count(),
        kept_tris_before,
        "a 0.9mm poke is within the 1mm vertex clearance; nothing should be dropped"
    );

    // Poke = 0.0011 > VERTEX_CLEARANCE (1e-3): the stray vertex clears the
    // host by more than tolerance -> the needle triangle is DROPPED, the
    // anchor triangle survives -> exactly one triangle remains.
    let dropped = needle_and_anchor(0.0011);
    let out_dropped = drop_faces_outside_host(dropped, &host);
    assert_eq!(
        out_dropped.triangle_count(),
        1,
        "a 1.1mm poke exceeds the 1mm vertex clearance; the needle triangle must be dropped, \
         leaving only the anchor triangle"
    );
}
