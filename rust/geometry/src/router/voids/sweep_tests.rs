// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Round-26 mutation-audit fixtures for the two never-mutated magic
//! constants in this file: the `cut_changed_mesh` volume-drift tolerance
//! (1.0e-3, relative to `vol_before`) and `drop_faces_outside_host`'s
//! `VERTEX_CLEARANCE` (1.0e-3, absolute). Both had zero unit-level coverage
//! before this round — only exercised transitively through full IFC-fixture
//! integration tests, which never probed the boundary magnitude.

use super::*;
use crate::Vector3;

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

#[test]
fn cut_changed_mesh_volume_drift_boundary_is_1e_3_relative() {
    // Unit cube -> mesh_signed_volume magnitude is exactly 1.0.
    let cube = box_mesh((0.0, 0.0, 0.0), (1.0, 1.0, 1.0));
    let vol_after = mesh_signed_volume(&cube).abs();
    assert!((vol_after - 1.0).abs() < 1e-6, "sanity: unit cube volume ~1.0, got {vol_after}");
    let tris = cube.triangle_count();

    // Just under the 1e-3 relative-to-vol_before threshold -> NOT changed.
    // vol_before = 0.99901: diff = 0.00099, threshold = 0.99901 * 1e-3 = 0.00099901.
    let not_changed = cut_changed_mesh(&cube, tris, 0.99901);
    assert!(
        !not_changed,
        "a 0.099% volume drift is inside the 0.1% tolerance and must read as unchanged"
    );

    // Just over the threshold -> changed.
    // vol_before = 0.99899: diff = 0.00101, threshold = 0.99899 * 1e-3 = 0.00099899.
    let changed = cut_changed_mesh(&cube, tris, 0.99899);
    assert!(
        changed,
        "a 0.101% volume drift exceeds the 0.1% tolerance and must read as changed"
    );
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
