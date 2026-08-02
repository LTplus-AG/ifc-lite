// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #977 — Tekla flush end recesses under-cut.
//!
//! Steel exports (Tekla Structures, IFC2X3, millimetres) author end-of-member
//! recesses as `IfcOpeningElement` voids whose cut face is EXACTLY coincident
//! with the host member's face. Manifold's coplanar-face classifier can't
//! reliably decide material across coincident faces, so the recess used to
//! under-remove — a thin residual wall remained (or nothing was cut).
//!
//! The cutter is inflated around its centroid before the boolean
//! ([`manifold_kernel::perturb_around_centroid`]); the bug was that the
//! inflation was sized from the cutter's *largest* half-extent, so the flush
//! face of a long-member shallow recess was under-inflated by the cutter's
//! aspect ratio and stayed below Manifold's (host-bbox-relative) coplanarity
//! epsilon. The fix keys the inflation off the *smallest* half-extent and the
//! *combined host+void bbox*.
//!
//! A unit-scale "box + flush recess" does NOT reproduce this (Manifold's
//! epsilon is bbox-relative, so at unit scale a thin cutter already clears).
//! This fixture mirrors the Tekla geometry: a 12 m member in mm with a shallow
//! flush recess, and asserts via a point-in-solid ray cast that a point inside
//! the recess pocket ends up OUTSIDE the solid — i.e. the cut went all the way
//! through with no residual wall.

use ifc_lite_geometry::{ClippingProcessor, Mesh, Point3, Vector3};

/// Axis-aligned closed box (12 triangles, outward winding) from `min` to `max`.
fn box_mesh(min: [f64; 3], max: [f64; 3]) -> Mesh {
    let mut m = Mesh::with_capacity(8, 36);
    let n = Vector3::new(0.0, 0.0, 0.0);
    let v = |i: usize| {
        Point3::new(
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        )
    };
    for i in 0..8 {
        m.add_vertex(v(i), n);
    }
    // 6 quads (two tris each); winding is irrelevant — the kernel reorients.
    let faces: [[u32; 6]; 6] = [
        [0, 1, 3, 0, 3, 2], // z-min
        [4, 6, 7, 4, 7, 5], // z-max
        [0, 4, 5, 0, 5, 1], // y-min
        [2, 3, 7, 2, 7, 6], // y-max
        [0, 2, 6, 0, 6, 4], // x-min
        [1, 5, 7, 1, 7, 3], // x-max
    ];
    for f in &faces {
        m.add_triangle(f[0], f[1], f[2]);
        m.add_triangle(f[3], f[4], f[5]);
    }
    m
}

/// Möller–Trumbore ray/triangle intersection. Returns `t > eps` if the ray
/// `orig + t*dir` hits the triangle in its forward half-line.
fn ray_hits(orig: [f64; 3], dir: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> bool {
    const EPS: f64 = 1e-9;
    let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let p = [
        dir[1] * e2[2] - dir[2] * e2[1],
        dir[2] * e2[0] - dir[0] * e2[2],
        dir[0] * e2[1] - dir[1] * e2[0],
    ];
    let det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if det.abs() < EPS {
        return false; // parallel
    }
    let inv = 1.0 / det;
    let t = [orig[0] - a[0], orig[1] - a[1], orig[2] - a[2]];
    let u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) * inv;
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = [
        t[1] * e1[2] - t[2] * e1[1],
        t[2] * e1[0] - t[0] * e1[2],
        t[0] * e1[1] - t[1] * e1[0],
    ];
    let w = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if w < 0.0 || u + w > 1.0 {
        return false;
    }
    let t_hit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    t_hit > EPS
}

/// Even-odd point-in-solid test: a point is inside a closed mesh iff a ray from
/// it crosses an odd number of triangles. Direction is slightly skewed off-axis
/// to avoid grazing the axis-aligned faces.
fn point_inside(mesh: &Mesh, p: [f64; 3]) -> bool {
    let dir = [0.0131, 0.0271, -1.0];
    let mut hits = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let g = |i: u32| {
            let o = i as usize * 3;
            [
                mesh.positions[o] as f64,
                mesh.positions[o + 1] as f64,
                mesh.positions[o + 2] as f64,
            ]
        };
        if ray_hits(p, dir, g(tri[0]), g(tri[1]), g(tri[2])) {
            hits += 1;
        }
    }
    hits % 2 == 1
}

#[test]
fn tekla_flush_end_recess_cuts_through() {
    // 12 m member, 300 × 300 mm cross-section (millimetres, like the Tekla file).
    const L: f64 = 12_000.0;
    const W: f64 = 300.0;
    const H: f64 = 300.0;
    let host = box_mesh([0.0, 0.0, 0.0], [L, W, H]);

    // Shallow recess at the +x end, top corner. Flush (coincident) with the
    // host face at x = L; through in y and out the top in z, so x = L is the
    // single coincident cut face — the degeneracy that defeated the kernel.
    // Cut depth on x is only 50 mm (the thin axis that drove the under-cut).
    const D: f64 = 50.0; // recess depth along x (shallow)
    const T: f64 = 100.0; // recess height removed below the top
    let cutter = box_mesh([L - D, -50.0, H - T], [L, W + 50.0, H + 50.0]);

    let clipper = ClippingProcessor::new();
    let result = clipper
        .subtract_mesh(&host, &cutter)
        .expect("subtract_mesh must not error");

    assert!(
        !result.positions.is_empty() && !result.indices.is_empty(),
        "cut produced an empty mesh"
    );

    let host_tris = host.indices.len() / 3;
    let result_tris = result.indices.len() / 3;
    assert!(
        result_tris != host_tris,
        "result has the same {host_tris} triangles as the un-cut host — recess was not carved"
    );

    // A point in the middle of the recess pocket must be OUTSIDE the cut solid.
    // Pre-fix it stayed inside (residual material under the coincident face).
    let probe = [L - D * 0.5, W * 0.5, H - T * 0.5]; // (11975, 150, 250)
    assert!(
        !point_inside(&result, probe),
        "probe {probe:?} is still inside the solid — the flush recess under-cut \
         (issue #977 residual wall)"
    );

    // Sanity: a point in the solid bulk (far from the recess) stays inside.
    let bulk = [L * 0.25, W * 0.5, H * 0.5];
    assert!(
        point_inside(&result, bulk),
        "bulk point {bulk:?} fell outside the solid — the cut removed too much"
    );
}
