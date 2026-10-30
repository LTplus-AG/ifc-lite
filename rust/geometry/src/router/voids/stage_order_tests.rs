// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Frozen order of the void-cut stage chain (#8263, C2-7).
//!
//! The chain's order is part of the geometry-output and diagnostics contract
//! (`docs/architecture/mesh-determinism.md`), and before C2-7 nothing failed
//! when two stages traded places. Each test here uses a fixture on which the
//! two neighbours it guards give different observable results, so swapping or
//! dropping one turns it red:
//!
//! - ParamRect before Bool2d (both fixtures eligible on one host);
//! - malformed recut before the flap clip, and the sliver refinement kept;
//! - a rejected frame retry restoring the first run's diagnostics;
//! - the coaxial union before the disjoint-batch plan.
//!
//! Not pinned here: the shard sweep's `host_mutated` gate. Forcing the sweep
//! always on or always off changes no output in this crate's tests, and no
//! host in the local corpus has a face the sweep would drop either way, so no
//! reachable fixture tells the two apart (`tests/evidence/c2-7a/port-notes.txt`).

use super::super::*;
use crate::csg::CsgCensus;
use crate::profile::Profile2D;
use nalgebra::{Matrix4, Point2};

fn box_mesh(mn: [f64; 3], mx: [f64; 3]) -> Mesh {
    GeometryRouter::make_box_mesh(Point3::new(mn[0], mn[1], mn[2]), Point3::new(mx[0], mx[1], mx[2]))
}

fn mesh_cutter(mn: [f64; 3], mx: [f64; 3], depth: Option<Vector3<f64>>) -> CutterKind {
    let (lo, hi) = (Point3::new(mn[0], mn[1], mn[2]), Point3::new(mx[0], mx[1], mx[2]));
    CutterKind::NonRectangular(GeometryRouter::make_box_mesh(lo, hi), lo, hi, depth)
}

fn context(openings: Vec<CutterKind>) -> VoidContext {
    VoidContext {
        merged_openings: GeometryRouter::merge_rectangular_openings(&openings),
        openings,
        param: None,
        bool2d: None,
    }
}

/// The mesh without the faces whose normal points along `+axis`: an open host,
/// which is where the post passes stop commuting.
fn without_faces_facing(mesh: &Mesh, axis: usize) -> Mesh {
    let at = |i: u32| {
        let b = i as usize * 3;
        Vector3::new(mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64)
    };
    let mut open = mesh.clone();
    open.indices = mesh
        .indices
        .chunks_exact(3)
        .filter(|t| {
            let n = (at(t[1]) - at(t[0])).cross(&(at(t[2]) - at(t[0])));
            n[axis] <= 0.99 * n.norm()
        })
        .flatten()
        .copied()
        .collect();
    open
}

fn same_mesh(a: &Mesh, b: &Mesh) -> bool {
    a.positions == b.positions && a.indices == b.indices
}

/// A 4 x 3 m plate, 0.2 m thick along z, through-cut by a 1 x 1 m opening
/// that BOTH the parametric box cut and the 2D re-extrude can take.
fn plate_with_both_fast_paths() -> (Mesh, VoidContext) {
    let rect = |x0: f64, y0: f64, x1: f64, y1: f64| {
        vec![Point2::new(x0, y0), Point2::new(x1, y0), Point2::new(x1, y1), Point2::new(x0, y1)]
    };
    let profile = Profile2D::new(rect(0.0, 0.0, 4.0, 3.0));
    let host = crate::extrusion::extrude_profile_watertight(&profile, 0.2, None).unwrap();
    let opening = CutterKind::Rectangular(
        Point3::new(1.0, 1.0, -0.5),
        Point3::new(2.0, 2.0, 0.7),
        Some(Vector3::z()),
    );
    let param_box = |center: [f64; 3], half: [f64; 3]| RectParam {
        r: Matrix3::identity(),
        center: Point3::new(center[0], center[1], center[2]),
        half,
    };
    let mut ctx = context(vec![opening]);
    ctx.param = Some(ParamRectCut {
        host: param_box([2.0, 1.5, 0.1], [2.0, 1.5, 0.1]),
        openings: vec![param_box([1.5, 1.5, 0.1], [0.5, 0.5, 0.1])],
    });
    ctx.bool2d = Some(bool2d_path::Bool2dCut {
        host_profile: profile,
        depth: 0.2,
        dir_sign: 1.0,
        wt: Matrix4::identity(),
        footprints: vec![rect(1.0, 1.0, 2.0, 2.0)],
        residual: None,
    });
    (host, ctx)
}

/// ParamRect is tried before Bool2d: on a host both can cut, the parametric
/// cut is the one emitted (it is the only stage that records rect_fast stats).
#[test]
fn param_rect_is_tried_before_bool2d() {
    let (host, ctx) = plate_with_both_fast_paths();
    let router = GeometryRouter::new();
    // The fixture is sensitive: on its own, the 2D route accepts this host.
    let bool2d = router.try_staged_bool2d(&host, ctx.bool2d.as_ref().unwrap(), 1);
    assert!(bool2d.is_some(), "the 2D route must accept the fixture on its own");
    router.take_rect_fast_stats();
    if !crate::rect_fast::param_enabled() {
        return; // IFC_LITE_RECT_PARAM=0: the parametric stage is off by request
    }
    let out = router.apply_void_context(host, &ctx, 1);
    assert_eq!(router.take_rect_fast_stats().fired, 1, "the parametric stage must cut first");
    assert!(crate::exact_topology::strict_closed_mesh(&out));
    let removed = 4.0 * 3.0 * 0.2 - mesh_signed_volume(&out).abs();
    assert!((removed - 0.2).abs() < 1e-3, "removed {removed}");
}

/// The exact tail's post passes run recut -> flap clip, after the sliver
/// refinement. On an OPEN host (top face missing) the recut and the clip do
/// not commute, so the expected result is composed here from the same passes
/// in the frozen order and the swapped order is shown to differ.
///
/// Excluded under the topology/manifold gates, like the open-box tests in
/// `csg_tests.rs` (#3440): they refuse to cut an open host, so the recut does
/// nothing and the fixture cannot tell the orders apart.
#[cfg(not(any(feature = "csg_topology_gate", feature = "csg_manifold_gate")))]
#[test]
fn malformed_recut_runs_before_the_flap_clip() {
    let host = without_faces_facing(&box_mesh([-2.0, -0.1, 0.0], [2.0, 0.1, 3.0]), 2);
    // A box cutter carrying far "fin" triangles 9 m off the wall: malformed,
    // so the exact passes skip it and only the recut carves it.
    let mut cutter = box_mesh([-0.5, -0.3, 1.0], [0.5, 0.3, 2.0]);
    let base = (cutter.positions.len() / 3) as u32;
    for y in [9.0f32, -9.0] {
        for (dx, dz) in [(0.0, 0.0), (0.05, 0.0), (0.0, 0.05)] {
            cutter.positions.extend_from_slice(&[dx, y, 1.5 + dz]);
            cutter.normals.extend_from_slice(&[0.0, 1.0, 0.0]);
        }
    }
    cutter.indices.extend((base..base + 6).collect::<Vec<_>>());
    assert!(malformed_opening_repair::opening_obb_if_malformed(&cutter).is_some());
    let (lo, hi) = cutter.bounds();
    let ctx = context(vec![CutterKind::NonRectangular(cutter, lo.cast(), hi.cast(), Some(Vector3::y()))]);

    let welded = crate::facet_weld::weld_near_coplanar_facets(&host);
    let (wall_min, wall_max) = welded.bounds();
    let clip = |mesh: &mut Mesh| {
        mesh.clip_triangles_to_host_aabb(
            [wall_min.x, wall_min.y, wall_min.z],
            [wall_max.x, wall_max.y, wall_max.z],
        );
    };
    let refined = crate::facet_weld::refine_high_aspect_slivers(&welded);
    let mut expected = refined.clone();
    recut_malformed_openings(&mut expected, &ctx.malformed_opening_boxes());
    clip(&mut expected);
    let mut swapped = refined;
    clip(&mut swapped);
    recut_malformed_openings(&mut swapped, &ctx.malformed_opening_boxes());
    assert!(!same_mesh(&expected, &swapped), "the fixture must tell the two orders apart");

    let out = GeometryRouter::new().apply_void_context_inner(host.clone(), &ctx, 1, world_host_bounds(&host), false);
    assert!(same_mesh(&out, &expected), "recut must run before the flap clip");
}

/// Longest / shortest edge, as `facet_weld` measures a sliver.
fn worst_aspect(mesh: &Mesh) -> f64 {
    let at = |i: u32| {
        let b = i as usize * 3;
        Vector3::new(mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64)
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let e = [(at(t[0]) - at(t[1])).norm(), (at(t[1]) - at(t[2])).norm(), (at(t[2]) - at(t[0])).norm()];
            e.iter().copied().fold(0.0, f64::max) / e.iter().copied().fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
}

/// The exact tail ends with the #1007 sliver refinement: a long, thin wall cut
/// by a mesh cutter keeps no triangle past the 8:1 bar. Without the pass the
/// wall's 4 m x 0.2 m top face alone is a 20:1 pair.
#[test]
fn exact_tail_output_keeps_no_sliver() {
    let host = box_mesh([-2.0, -0.1, 0.0], [2.0, 0.1, 3.0]);
    assert!(worst_aspect(&host) > 8.0, "the fixture must start with slivers");
    let ctx = context(vec![mesh_cutter([-0.5, -0.3, 1.0], [0.5, 0.3, 2.0], Some(Vector3::y()))]);
    let out = GeometryRouter::new().apply_void_context_inner(host.clone(), &ctx, 1, world_host_bounds(&host), false);
    assert!(crate::exact_topology::strict_closed_mesh(&out));
    let aspect = worst_aspect(&out);
    assert!(aspect <= 8.0 + 1e-6, "sliver of {aspect}:1 left by the exact tail");
}

/// `R_z(deg)` then translate to `at`, applied to f32 positions.
fn plan_rotated(mesh: &Mesh, deg: f64, at: [f64; 3]) -> Mesh {
    let (s, c) = deg.to_radians().sin_cos();
    let mut out = mesh.clone();
    for p in out.positions.chunks_exact_mut(3) {
        let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
        p[0] = (c * x - s * y + at[0]) as f32;
        p[1] = (s * x + c * y + at[1]) as f32;
        p[2] = (z + at[2]) as f32;
    }
    out
}

/// A plan-rotated wall 230 m out with its top face missing: the wall-frame cut
/// comes back open, so the frame stage retries on snapped operands; the retry
/// is open too and is rejected. The first run's output is kept, and so must be
/// its diagnostics: one cut-effect record describing the emitted mesh, none of
/// the retry's (which cut to a different triangle count).
#[test]
fn rejected_frame_retry_restores_the_first_runs_diagnostics() {
    const DEG: f64 = 30.0;
    const AT: [f64; 3] = [200.0, 115.0, 12.0];
    let host = plan_rotated(&without_faces_facing(&box_mesh([-4.0, -0.15, 0.0], [4.0, 0.15, 3.0]), 2), DEG, AT);
    let cutter = plan_rotated(&box_mesh([-0.4, -0.3, 0.9], [0.8, 0.3, 2.1]), DEG, AT);
    let depth = Vector3::new(-DEG.to_radians().sin(), DEG.to_radians().cos(), 0.0);
    let frame = infer_opening_frame(&cutter, Some(&depth)).expect("a box has a frame");
    let ctx = context(vec![CutterKind::DiagonalRectangular(cutter, frame)]);
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    let out = router.apply_void_context_inner(host.clone(), &ctx, 1, world_host_bounds(&host), true);
    assert!(!out.is_empty() && !crate::exact_topology::strict_closed_mesh(&out), "the fixture must stay open");
    let diagnostics = router.take_host_opening_diagnostics();
    let host_record = diagnostics.get(&1).expect("the kept run records its cut");
    assert_eq!(host_record.tris_before, Some(host.triangle_count()));
    assert_eq!(host_record.tris_after, Some(out.triangle_count()), "diagnostics must describe the kept run");
}

/// The coaxial union is a whole-set prepass that runs BEFORE the disjoint
/// batch is planned: the two overlapping coaxial boxes are cut as one fused
/// prism, and the remaining disjoint box is cut on its own. Planning first
/// would batch a consumed box with the disjoint one and cut it twice.
#[test]
fn coaxial_union_runs_before_the_batch_plan() {
    let host = box_mesh([-2.0, -0.15, -1.5], [2.0, 0.15, 1.5]);
    let through = |x0: f64, x1: f64| mesh_cutter([x0, -0.4, -0.6], [x1, 0.4, 0.6], Some(Vector3::y()));
    let ctx = context(vec![through(-1.6, -0.6), through(-1.0, 0.0), through(0.8, 1.6)]);
    let census = CsgCensus::new();
    let router = GeometryRouter::new();
    coaxial_union::set_enabled_override(Some(true));
    let out = census.with_scope(|| {
        router.apply_void_context_inner(host.clone(), &ctx, 1, world_host_bounds(&host), false)
    });
    coaxial_union::set_enabled_override(None);
    // Every subtract takes one 12-triangle box: the fused union, then the
    // disjoint opening. A batched pair would be one subtract of 24.
    let cutter_tris: Vec<(u8, u32)> = census.take().iter().map(|r| (r.op, r.b_tris)).collect();
    assert_eq!(cutter_tris, [(0, 12), (0, 12)]);
    assert!(crate::exact_topology::strict_closed_mesh(&out));
    let removed = 4.0 * 0.3 * 3.0 - mesh_signed_volume(&out).abs();
    let expected = (1.6 + 0.8) * 0.3 * 1.2;
    assert!((removed - expected).abs() < 5e-3, "removed {removed}, expected {expected}");
}
