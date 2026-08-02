// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the analytic convex-prism (oriented-box) subtraction path.

use super::*;
use crate::router::GeometryRouter;
use crate::{Mesh, Point3, Vector3};

/// Closed box mesh with outward flat-shaded faces (per-face vertices), built
/// from an oriented frame: `center + axes·(±half)`.
fn framed_box_mesh(center: [f64; 3], axes: [[f64; 3]; 3], half: [f64; 3]) -> Mesh {
    let corner = |sx: f64, sy: f64, sz: f64| -> [f64; 3] {
        let mut p = center;
        for k in 0..3 {
            p[k] += axes[0][k] * (sx * half[0])
                + axes[1][k] * (sy * half[1])
                + axes[2][k] * (sz * half[2]);
        }
        p
    };
    let c = [
        corner(-1.0, -1.0, -1.0),
        corner(1.0, -1.0, -1.0),
        corner(1.0, 1.0, -1.0),
        corner(-1.0, 1.0, -1.0),
        corner(-1.0, -1.0, 1.0),
        corner(1.0, -1.0, 1.0),
        corner(1.0, 1.0, 1.0),
        corner(-1.0, 1.0, 1.0),
    ];
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::new();
    for f in &faces {
        let a = c[f[0]];
        let b = c[f[1]];
        let d = c[f[2]];
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        let nn = [
            (n[0] / len) as f32,
            (n[1] / len) as f32,
            (n[2] / len) as f32,
        ];
        let base = (m.positions.len() / 3) as u32;
        for &i in f {
            m.positions.extend_from_slice(&[
                c[i][0] as f32,
                c[i][1] as f32,
                c[i][2] as f32,
            ]);
            m.normals.extend_from_slice(&nn);
        }
        m.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    m
}

fn axis_frame() -> [[f64; 3]; 3] {
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
}

/// Frame rotated by `angle` radians about Z.
fn rot_z_frame(angle: f64) -> [[f64; 3]; 3] {
    let (s, c) = angle.sin_cos();
    [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// A 4 m × 0.3 m × 3 m wall (thin along Y), centred at `center`, in frame `axes`.
fn wall(center: [f64; 3], axes: [[f64; 3]; 3]) -> Mesh {
    framed_box_mesh(center, axes, [2.0, 0.15, 1.5])
}

fn ctx_of(openings: Vec<OpeningType>) -> VoidContext {
    VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    }
}

fn mesh_volume(m: &Mesh) -> f64 {
    super::super::geom::mesh_signed_volume(m).abs()
}

fn watertight(m: &Mesh) -> bool {
    super::super::geom::param_cut_watertight(m)
}

/// An L-shaped (non-convex) cutter: two glued boxes sharing a face, welded to
/// one closed shell via the exact union of their triangles is complex; instead
/// author it directly as an open-stepped shell that is NOT a box (extra
/// interior planes). The detection must reject it.
fn l_shaped_cutter() -> Mesh {
    // Two boxes side by side with different heights — the merged mesh has two
    // top planes on the same axis, which `detect_box` must reject even though
    // each individual facet is axis-aligned.
    let a = framed_box_mesh([0.0, 0.0, 0.5], axis_frame(), [0.4, 0.4, 0.5]);
    let b = framed_box_mesh([0.6, 0.0, 0.25], axis_frame(), [0.2, 0.4, 0.25]);
    let mut m = a;
    let base = (m.positions.len() / 3) as u32;
    m.positions.extend_from_slice(&b.positions);
    m.normals.extend_from_slice(&b.normals);
    m.indices.extend(b.indices.iter().map(|i| i + base));
    m
}

#[test]
fn box_cutter_through_wall_watertight_and_volume_exact() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    // Window 1.0 × 1.0, penetrating the full 0.3 thickness plus slack.
    let cutter = framed_box_mesh([0.3, 0.0, 0.2], axis_frame(), [0.5, 0.4, 0.5]);
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        Some(Vector3::new(0.0, 1.0, 0.0)),
    )]);
    let (cut, residual) = router
        .try_prism_cut(&host, &ctx)
        .expect("box cutter must take the prism path");
    assert!(residual.is_none(), "single eligible opening leaves no residual");
    assert!(watertight(&cut), "prism cut must be watertight");
    // Removed volume = 1.0 × 0.3 × 1.0 (the cutter clamped to the wall).
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    assert!(
        (removed - 0.3).abs() < 1.0e-3,
        "removed {removed}, expected 0.3"
    );
}

#[test]
fn rotated_prism_cutter_fires_and_reconciles() {
    let router = GeometryRouter::new();
    let frame = rot_z_frame(0.5); // ~28.6° in plan — far past the axis-aligned gates
    let host = wall([10.0, 5.0, 2.0], frame);
    // Window box in the SAME rotated frame, poking through the thickness.
    let cutter = framed_box_mesh(
        {
            // center + 0.3·len_axis + 0.2·up_axis
            let mut c = [10.0, 5.0, 2.0];
            for k in 0..3 {
                c[k] += frame[0][k] * 0.3 + frame[2][k] * 0.2;
            }
            c
        },
        frame,
        [0.5, 0.4, 0.5],
    );
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        None,
    )]);
    let (cut, residual) = router
        .try_prism_cut(&host, &ctx)
        .expect("rotated box cutter must take the prism path");
    assert!(residual.is_none());
    assert!(watertight(&cut), "rotated prism cut must be watertight");
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    assert!(
        (removed - 0.3).abs() < 1.0e-3,
        "removed {removed}, expected 0.3"
    );
}

#[test]
fn non_convex_cutter_falls_back() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    let cutter = l_shaped_cutter();
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        None,
    )]);
    assert!(
        router.try_prism_cut(&host, &ctx).is_none(),
        "non-box cutter must defer to the exact kernel"
    );
}

#[test]
fn open_shell_cutter_falls_back() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    // A box with one face deleted: not a closed 2-manifold.
    let mut cutter = framed_box_mesh([0.3, 0.0, 0.2], axis_frame(), [0.5, 0.4, 0.5]);
    cutter.indices.truncate(cutter.indices.len() - 6);
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        None,
    )]);
    assert!(
        router.try_prism_cut(&host, &ctx).is_none(),
        "open-shell cutter must defer (volume/manifold reconciliation)"
    );
}

#[test]
fn multi_window_host_watertight_and_volume_exact() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    let mut openings = Vec::new();
    for i in 0..3 {
        let cx = -1.3 + i as f64 * 1.2;
        let cutter = framed_box_mesh([cx, 0.0, 0.1], axis_frame(), [0.35, 0.4, 0.45]);
        let (mn, mx) = cutter.bounds();
        openings.push(OpeningType::NonRectangular(
            cutter,
            Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
            Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
            Some(Vector3::new(0.0, 1.0, 0.0)),
        ));
    }
    let ctx = ctx_of(openings);
    // NOTE: path coverage is asserted through the RETURN VALUE, never through
    // `take_prism_stats()` — the stats are process-global atomics shared by
    // every concurrently running test in this binary, so exact counts are a
    // scheduling race (CI x86_64 runners interleave differently than a local
    // many-core arm64). `Some(..)` proves the prism path fired; a `None`
    // residual proves EVERY opening was cut analytically.
    let (cut, residual) = router
        .try_prism_cut(&host, &ctx)
        .expect("three windows must all take the prism path");
    assert!(residual.is_none(), "all three windows must be analytic");
    assert!(watertight(&cut), "multi-window cut must be watertight");
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    let expect = 3.0 * 0.7 * 0.3 * 0.9;
    assert!(
        (removed - expect).abs() < 1.0e-3,
        "removed {removed}, expected {expect}"
    );
}

#[test]
fn mixed_eligible_and_ineligible_returns_residual() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    let window = framed_box_mesh([-1.0, 0.0, 0.2], axis_frame(), [0.4, 0.4, 0.4]);
    let (wmn, wmx) = window.bounds();
    let l = l_shaped_cutter();
    let (lmn, lmx) = l.bounds();
    let ctx = ctx_of(vec![
        OpeningType::NonRectangular(
            window,
            Point3::new(wmn.x as f64, wmn.y as f64, wmn.z as f64),
            Point3::new(wmx.x as f64, wmx.y as f64, wmx.z as f64),
            Some(Vector3::new(0.0, 1.0, 0.0)),
        ),
        OpeningType::NonRectangular(
            l,
            Point3::new(lmn.x as f64, lmn.y as f64, lmn.z as f64),
            Point3::new(lmx.x as f64, lmx.y as f64, lmx.z as f64),
            None,
        ),
    ]);
    let (cut, residual) = router
        .try_prism_cut(&host, &ctx)
        .expect("the eligible window must be cut analytically");
    let residual = residual.expect("the L-shaped void must come back as residual");
    assert_eq!(residual.merged_openings.len(), 1);
    assert!(watertight(&cut));
    // Only the window was removed so far.
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    let expect = 0.8 * 0.3 * 0.8;
    assert!(
        (removed - expect).abs() < 1.0e-3,
        "removed {removed}, expected {expect}"
    );
}

#[test]
fn blind_recess_keeps_authored_depth() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    // Recess: half the wall thickness deep, entering from the -Y face only
    // (front face at y = -0.15; recess bottom at y = 0.0, strictly interior).
    let cutter = framed_box_mesh([0.0, -0.1, 0.0], axis_frame(), [0.4, 0.1, 0.4]);
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        Some(Vector3::new(0.0, 1.0, 0.0)),
    )]);
    let (cut, residual) = router
        .try_prism_cut(&host, &ctx)
        .expect("blind recess must take the prism path");
    assert!(residual.is_none());
    assert!(watertight(&cut), "recess cut must be watertight");
    // Removed = recess ∩ wall = 0.8 × 0.15 × 0.8 (from front face to bottom).
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    let expect = 0.8 * 0.15 * 0.8;
    assert!(
        (removed - expect).abs() < 1.0e-3,
        "removed {removed}, expected {expect}"
    );
}

#[test]
fn deterministic_output() {
    let router = GeometryRouter::new();
    let host = wall([100.0, 50.0, 20.0], rot_z_frame(0.3));
    let frame = rot_z_frame(0.3);
    let cutter = framed_box_mesh(
        {
            let mut c = [100.0, 50.0, 20.0];
            for k in 0..3 {
                c[k] += frame[0][k] * 0.4;
            }
            c
        },
        frame,
        [0.5, 0.4, 0.5],
    );
    let (mn, mx) = cutter.bounds();
    let mk = |cutter: Mesh| {
        ctx_of(vec![OpeningType::NonRectangular(
            cutter,
            Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
            Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
            None,
        )])
    };
    let (a, _) = router.try_prism_cut(&host, &mk(cutter.clone())).unwrap();
    let (b, _) = router.try_prism_cut(&host, &mk(cutter)).unwrap();
    assert_eq!(a.positions, b.positions, "prism cut must be deterministic");
    assert_eq!(a.indices, b.indices);
    assert_eq!(a.normals, b.normals);
}

#[test]
fn engulfing_cutter_defers_to_exact_semantics() {
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    // A box that contains the whole wall: the exact path owns the
    // engulf/redundant-void semantics (#964), so the prism path must defer.
    let cutter = framed_box_mesh([0.0, 0.0, 0.0], axis_frame(), [3.0, 1.0, 2.0]);
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        None,
    )]);
    assert!(router.try_prism_cut(&host, &ctx).is_none());
}

/// Closed stepped-extrusion cutter (the ISSUE_098 rebated masonry opening):
/// outer profile rectangle over the first depth slab, smaller inner rectangle
/// over the second, with the exposed step ring capped by four trapezoids — a
/// watertight stepped solid. Depth axis +Y; profiles in (x, z).
fn stepped_cutter(
    outer: ([f64; 2], [f64; 2]),
    inner: ([f64; 2], [f64; 2]),
    y0: f64,
    y_step: f64,
    y1: f64,
) -> Mesh {
    let mut m = Mesh::new();
    // Quad with the winding auto-oriented so its normal points along `want`.
    let mut quad = |mut corners: [[f64; 3]; 4], want: [f64; 3]| {
        let n_of = |c: &[[f64; 3]; 4]| {
            let e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
            let e2 = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
            [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ]
        };
        let n = n_of(&corners);
        if n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0.0 {
            corners.swap(1, 3);
        }
        let n = n_of(&corners);
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        let nf = [(n[0] / l) as f32, (n[1] / l) as f32, (n[2] / l) as f32];
        let base = (m.positions.len() / 3) as u32;
        for p in corners {
            m.positions
                .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            m.normals.extend_from_slice(&nf);
        }
        m.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    let (o_lo, o_hi) = outer;
    let (i_lo, i_hi) = inner;
    let o = [
        [o_lo[0], o_lo[1]],
        [o_hi[0], o_lo[1]],
        [o_hi[0], o_hi[1]],
        [o_lo[0], o_hi[1]],
    ];
    let iv = [
        [i_lo[0], i_lo[1]],
        [i_hi[0], i_lo[1]],
        [i_hi[0], i_hi[1]],
        [i_lo[0], i_hi[1]],
    ];
    let at = |p: [f64; 2], y: f64| [p[0], y, p[1]];
    // Bottom cap at y0 (outer profile, normal -Y) and top cap at y1 (inner,
    // +Y).
    quad([at(o[0], y0), at(o[1], y0), at(o[2], y0), at(o[3], y0)], [0.0, -1.0, 0.0]);
    quad([at(iv[0], y1), at(iv[1], y1), at(iv[2], y1), at(iv[3], y1)], [0.0, 1.0, 0.0]);
    // Step ring at y_step: four trapezoids (outer edge k, inner edge k) — no
    // T-junctions against the side walls.
    for k in 0..4 {
        let k1 = (k + 1) % 4;
        quad(
            [
                at(o[k], y_step),
                at(o[k1], y_step),
                at(iv[k1], y_step),
                at(iv[k], y_step),
            ],
            [0.0, 1.0, 0.0],
        );
    }
    // Side walls: outer ring over [y0, y_step], inner over [y_step, y1]; the
    // outward direction is the edge's 2D normal.
    let mut walls = |ring: [[f64; 2]; 4], ya: f64, yb: f64| {
        for k in 0..4 {
            let k1 = (k + 1) % 4;
            let e = [ring[k1][0] - ring[k][0], ring[k1][1] - ring[k][1]];
            let want = [e[1], 0.0, -e[0]]; // outward for a CCW (x,z) ring
            quad(
                [
                    at(ring[k], ya),
                    at(ring[k1], ya),
                    at(ring[k1], yb),
                    at(ring[k], yb),
                ],
                want,
            );
        }
    };
    walls(o, y0, y_step);
    walls(iv, y_step, y1);
    m
}

#[test]
fn rebated_stepped_cutter_fires_watertight_and_volume_exact() {
    // 4 m × 0.3 m × 3 m wall centred at origin (thin along Y).
    let router = GeometryRouter::new();
    let host = wall([0.0, 0.0, 0.0], axis_frame());
    // Rebated window: outer 1.2×1.2 over the front 0.15 m + slack, inner
    // 0.9×0.9 over the back 0.15 m + slack (the masonry Anschlag).
    let cutter = stepped_cutter(
        ([-0.6, -0.6], [0.6, 0.6]),
        ([-0.45, -0.45], [0.45, 0.45]),
        -0.25,
        0.0,
        0.25,
    );
    let (mn, mx) = cutter.bounds();
    let ctx = ctx_of(vec![OpeningType::NonRectangular(
        cutter,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        Some(Vector3::new(0.0, 1.0, 0.0)),
    )]);
    let _ = take_prism_defers();
    let got = router.try_prism_cut(&host, &ctx);
    if got.is_none() {
        panic!(
            "rebated stepped cutter must take the prism path; defers={:?}",
            take_prism_defers()
        );
    }
    // `Some(..)` + `None` residual prove the analytic path cut the (single)
    // opening; see the multi-window test for why global stats counters must
    // not be asserted from parallel unit tests.
    let (cut, residual) = got.unwrap();
    assert!(residual.is_none(), "the rebated opening must be analytic");
    assert!(
        watertight(&cut),
        "stepped cut must be watertight (quantized 2-manifold)"
    );
    // Removed = outer 1.2² over the front half (0.15) + inner 0.9² over the
    // back half (0.15).
    let removed = mesh_volume(&host) - mesh_volume(&cut);
    let expect = 1.2 * 1.2 * 0.15 + 0.9 * 0.9 * 0.15;
    assert!(
        (removed - expect).abs() < 2.0e-3,
        "removed {removed}, expected {expect}"
    );
}

/// Build a mesh from explicit f64 triangles (per-triangle vertices, computed
/// flat normal). Used to author precise boundary-edge configurations for the
/// `closed_or_hairline` self-check.
fn mesh_from_tris(tris: &[[[f64; 3]; 3]]) -> Mesh {
    let mut m = Mesh::new();
    for t in tris {
        let e1 = [
            t[1][0] - t[0][0],
            t[1][1] - t[0][1],
            t[1][2] - t[0][2],
        ];
        let e2 = [
            t[2][0] - t[0][0],
            t[2][1] - t[0][1],
            t[2][2] - t[0][2],
        ];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        let nn = [
            (n[0] / len) as f32,
            (n[1] / len) as f32,
            (n[2] / len) as f32,
        ];
        let base = (m.positions.len() / 3) as u32;
        for v in t {
            m.positions
                .extend_from_slice(&[v[0] as f32, v[1] as f32, v[2] as f32]);
            m.normals.extend_from_slice(&nn);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

/// The ORIGINAL midpoint-only hairline predicate (pre-fix), reproduced verbatim
/// so the tightening can be demonstrated against the exact configuration it
/// wrongly accepted. Do not "improve" this — it is a frozen witness.
fn old_closed_or_hairline(mesh: &Mesh) -> bool {
    type K = (i64, i64, i64);
    let key = |i: u32| -> K {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: std::collections::HashMap<(K, K), i64> = std::collections::HashMap::new();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            *edges.entry((x, y)).or_insert(0) += 1;
            *edges.entry((y, x)).or_insert(0) -= 1;
        }
    }
    if edges.is_empty() {
        return false;
    }
    let mut bad: Vec<(K, K, i64)> = Vec::new();
    for (&(a, b), &c) in edges.iter() {
        if c > 0 {
            bad.push((a, b, c));
        }
    }
    if bad.is_empty() {
        return true;
    }
    if bad.len() > 64 {
        return false;
    }
    let p = |k: K| [k.0 as f64, k.1 as f64, k.2 as f64];
    let dist_pt_seg = |x: [f64; 3], a: [f64; 3], b: [f64; 3]| -> f64 {
        let ab = sub(b, a);
        let l2 = dot(ab, ab);
        if l2 <= 0.0 {
            return norm(sub(x, a));
        }
        let t = (dot(sub(x, a), ab) / l2).clamp(0.0, 1.0);
        norm(sub(x, add(a, scale(ab, t))))
    };
    for (i, &(a, b, _)) in bad.iter().enumerate() {
        let mid = scale(add(p(a), p(b)), 0.5);
        let dir_i = sub(p(b), p(a));
        let mut covered = false;
        for (j, &(c, d, _)) in bad.iter().enumerate() {
            if i == j {
                continue;
            }
            if dot(dir_i, sub(p(d), p(c))) >= 0.0 {
                continue;
            }
            if dist_pt_seg(mid, p(c), p(d)) <= 2.0 {
                covered = true;
                break;
            }
        }
        if !covered {
            return false;
        }
    }
    true
}

/// A LONG unmatched boundary edge (`A→B`, 10 m along +x on the grid line y=0)
/// whose midpoint is merely GRAZED by a reverse-oriented edge that runs 0.3 mm
/// (3 grid units) off that line. The old midpoint-only test declared `A→B`
/// "covered" — the reverse edge passes 0.15 mm from the midpoint — and admitted
/// this open triangle as watertight, the exact hole the whole prism safety net
/// leans on. The tightened test groups edges by their supporting LINE: the
/// reverse edge is NOT collinear with `A→B` (its far endpoint sits 3 grid units
/// off, beyond the 2-unit slack), so `A→B` is genuinely uncovered along its own
/// line and the surface is correctly rejected.
#[test]
fn hairline_long_edge_grazed_by_offline_reverse_now_rejected() {
    // Single open triangle: base A→B on y=0, apex 3 grid units off the line.
    let m = mesh_from_tris(&[[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 0.000_3, 0.0]]]);
    assert!(
        old_closed_or_hairline(&m),
        "the OLD midpoint test wrongly accepted the grazed long edge"
    );
    assert!(
        !closed_or_hairline(&m),
        "the tightened test must reject the genuinely-open long edge"
    );
}

/// Regression guard for the tightening: a genuine near-collinear hairline —
/// where the reverse edge DOES lie along the boundary line (0.1 mm / 1 grid
/// unit off, inside the 2-unit slack) and fully covers it — must still be
/// accepted, so the stricter self-check does not needlessly defer real
/// hairline hosts to the exact path.
#[test]
fn hairline_true_collinear_cover_still_accepted() {
    let m = mesh_from_tris(&[[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 0.000_1, 0.0]]]);
    assert!(
        closed_or_hairline(&m),
        "a near-collinear fully-covered hairline must remain accepted"
    );
}
