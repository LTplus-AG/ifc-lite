// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::router::voids::geom::mesh_signed_volume;

/// Closed axis-aligned box, 12 outward triangles.
fn box_mesh(min: [f64; 3], max: [f64; 3]) -> Mesh {
    let c = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
    ];
    let faces: [([usize; 4], [f32; 3]); 6] = [
        ([0, 3, 2, 1], [0.0, 0.0, -1.0]),
        ([4, 5, 6, 7], [0.0, 0.0, 1.0]),
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
        ([2, 3, 7, 6], [0.0, 1.0, 0.0]),
        ([0, 4, 7, 3], [-1.0, 0.0, 0.0]),
        ([1, 2, 6, 5], [1.0, 0.0, 0.0]),
    ];
    let mut m = Mesh::new();
    for (idx, n) in faces {
        let b = (m.positions.len() / 3) as u32;
        for &i in &idx {
            m.positions.extend_from_slice(&[c[i][0] as f32, c[i][1] as f32, c[i][2] as f32]);
            m.normals.extend_from_slice(&n);
        }
        m.indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }
    m
}

/// DIRECTED exact-f32-bit edge audit (the production crack detector,
/// mesh_bridge::exact_open_edges): a watertight oriented surface has every
/// directed edge cancelled by its reverse — catches both cracks AND
/// inconsistent winding.
fn open_edges(m: &Mesh) -> usize {
    use crate::mesh_check::{Degenerate, EdgeLedger, VertexKey};
    // `unbalanced` lists each open edge once; the directed audit counted it
    // in both directions.
    2 * EdgeLedger::build(m, VertexKey::Bits, Degenerate::SkipEdge).unbalanced().count()
}

fn degenerate(m: &Mesh) -> usize {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b], m.positions[b + 1], m.positions[b + 2]]
    };
    let mut n = 0;
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cr = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        if cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2] == 0.0 {
            n += 1;
        }
    }
    n
}

// 4m × 0.2m × 3m wall (thin along Y). Opening boxes poke through Y.
fn wall(base: [f64; 3]) -> Mesh {
    box_mesh(base, [base[0] + 4.0, base[1] + 0.2, base[2] + 3.0])
}
fn opening(base: [f64; 3], u0: f64, u1: f64, z0: f64, z1: f64) -> ([f64; 3], [f64; 3]) {
    (
        [base[0] + u0, base[1] - 0.1, base[2] + z0],
        [base[0] + u1, base[1] + 0.3, base[2] + z1],
    )
}

fn check_watertight(base: [f64; 3], openings: &[([f64; 3], [f64; 3])], label: &str) {
    let host = wall(base);
    let mut st = RectFastStats::default();
    let cut = subtract_rect_openings(&host, openings, &mut st)
        .unwrap_or_else(|| panic!("{label}: expected fast path to fire, deferred: {st:?}"));
    assert_eq!(open_edges(&cut), 0, "{label}: not watertight");
    assert_eq!(degenerate(&cut), 0, "{label}: degenerate triangles");
    // Removed volume ≈ Σ opening∩host volume.
    let removed = mesh_signed_volume(&host) - mesh_signed_volume(&cut);
    let mut expect = 0.0;
    let (hmn, hmx) = (base, [base[0] + 4.0, base[1] + 0.2, base[2] + 3.0]);
    for (omn, omx) in openings {
        let mut vv = 1.0;
        for k in 0..3 {
            vv *= (omx[k].min(hmx[k]) - omn[k].max(hmn[k])).max(0.0);
        }
        expect += vv;
    }
    // Volume tolerance scales with f32 ULP at the host's magnitude (a wall
    // 220 km from origin carries ~12 mm of inherent f32 error per coordinate
    // — true of ANY f32 mesh there, exact kernel included; the cut is still
    // watertight). Relative 2% OR absolute scale-aware, whichever is looser.
    let mag = base[0].abs().max(base[2].abs()).max(1.0);
    let vtol = (expect * 0.02).max(mag * 2f64.powi(-23) * 6.0);
    assert!(
        (removed - expect).abs() < vtol,
        "{label}: removed {removed} != expected {expect} (tol {vtol})"
    );
}

/// Flag semantics (pure core, no env mutation, safe under parallel tests):
/// `IFC_LITE_RECT_FAST=0` is the GLOBAL kill switch and also disables the
/// parametric path (even against an explicit `IFC_LITE_RECT_PARAM=1`);
/// `IFC_LITE_RECT_PARAM=0` disables only the parametric path; both unset
/// means the parametric path defaults ON.
#[test]
fn param_env_default_honours_global_kill_switch() {
    // Global kill switch thrown (IFC_LITE_RECT_FAST=0 => enabled() false).
    assert!(!param_env_default(false, None));
    assert!(!param_env_default(false, Some("1")));
    assert!(!param_env_default(false, Some("0")));
    // Parametric-only opt-out.
    assert!(!param_env_default(true, Some("0")));
    // Defaults ON; explicit "1" is also ON.
    assert!(param_env_default(true, None));
    assert!(param_env_default(true, Some("1")));
}

#[test]
fn single_opening_watertight_origin() {
    check_watertight([0.0, 0.0, 0.0], &[opening([0.0, 0.0, 0.0], 1.5, 2.5, 0.5, 2.0)], "single-origin");
}

#[test]
fn single_opening_watertight_building_scale() {
    check_watertight(
        [221_534.0, 98_210.0, 47_001.0],
        &[opening([221_534.0, 98_210.0, 47_001.0], 1.5, 2.5, 0.5, 2.0)],
        "single-building",
    );
}

#[test]
fn multi_opening_watertight() {
    let base = [10.0, 5.0, 2.0];
    let ops = [
        opening(base, 0.4, 1.2, 0.5, 2.4),
        opening(base, 1.6, 2.4, 0.5, 2.4),
        opening(base, 2.8, 3.6, 0.5, 1.0),
    ];
    check_watertight(base, &ops, "multi-3");
}

#[test]
fn defers_non_box_host() {
    // a tetrahedron-ish non-box host
    let mut host = Mesh::new();
    host.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    host.normals = vec![0.0; 12];
    host.indices = vec![0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    let mut st = RectFastStats::default();
    assert!(subtract_rect_openings(&host, &[opening([0.0, 0.0, 0.0], 1.5, 2.5, 0.5, 2.0)], &mut st).is_none());
    assert_eq!(st.defer_host_not_box, 1);
}

#[test]
fn defers_pathological_opening_count() {
    // A crafted host with hundreds of tiny openings makes build_cellular
    // O(N^3); the fast path must defer to the exact kernel, not hang.
    let host = box_mesh([0.0, 0.0, 0.0], [10.0, 3.0, 0.3]);
    let openings: Vec<([f64; 3], [f64; 3])> = (0..200)
        .map(|i| {
            let x = i as f64 * 0.04;
            ([x, 0.5, -0.1], [x + 0.02, 1.0, 0.4])
        })
        .collect();
    let mut st = RectFastStats::default();
    assert!(subtract_rect_openings(&host, &openings, &mut st).is_none());
    assert_eq!(st.defer_too_many_openings, 1);
}

#[test]
fn door_flush_to_floor_watertight() {
    // DOOR: full thickness, z from BELOW the floor up to 2.0 → touches the
    // wall's bottom edge (no sill reveal); the bottom face gets a hole. The
    // case the face-based v1 deferred (off_face); cellular cuts it watertight.
    let base = [0.0, 0.0, 0.0];
    let door = (
        [base[0] + 1.5, base[1] - 0.1, base[2] - 0.5],
        [base[0] + 2.5, base[1] + 0.3, base[2] + 2.0],
    );
    check_watertight(base, &[door], "door-flush-floor");
}

#[test]
fn edge_notch_watertight() {
    // opening that exceeds the wall's X extent → a notch flush with the right
    // edge (no right jamb). Was an off_face defer; cellular handles it.
    let base = [0.0, 0.0, 0.0];
    let notch = (
        [base[0] + 3.8, base[1] - 0.1, base[2] + 0.5],
        [base[0] + 4.5, base[1] + 0.3, base[2] + 2.0],
    );
    check_watertight(base, &[notch], "edge-notch");
}

#[test]
fn recess_cut_watertight() {
    // RECESS: does NOT span the full thickness (a niche/pocket). Was a
    // not_through defer; cellular cuts the pocket watertight.
    let base = [0.0, 0.0, 0.0];
    let recess = (
        [base[0] + 1.5, base[1] + 0.05, base[2] + 0.5],
        [base[0] + 2.5, base[1] + 0.15, base[2] + 2.0],
    );
    check_watertight(base, &[recess], "recess");
}

#[test]
fn opening_fully_outside_defers() {
    // genuine no-op: opening entirely outside the host → no overlap → defer.
    let base = [0.0, 0.0, 0.0];
    let outside = (
        [base[0] + 10.0, base[1] - 0.1, base[2] + 0.5],
        [base[0] + 11.0, base[1] + 0.3, base[2] + 2.0],
    );
    let mut st = RectFastStats::default();
    assert!(subtract_rect_openings(&wall(base), &[outside], &mut st).is_none());
}

#[test]
fn defers_near_edge_at_building_scale() {
    // 8 µm reveal at ~220 km: below f32 ULP → must defer (the robustness gate)
    let base = [221_534.0, 98_210.0, 47_001.0];
    let tight = opening(base, 8e-6, 4.0 - 8e-6, 8e-6, 3.0 - 8e-6);
    let mut st = RectFastStats::default();
    assert!(
        subtract_rect_openings(&wall(base), &[tight], &mut st).is_none(),
        "near-edge at building scale must defer, not crack"
    );
}

#[test]
fn issue_7292_one_grid_flush_head_gap_defers() {
    // ISSUE_129 #58297: these captured local cap heights differ by exactly
    // one grid step. The fast path must not turn import scatter into a lid.
    let top = 2.1500091552734375;
    let opening_top = 2.149993896484375;
    assert_eq!(top - opening_top, SNAP_GRID);
    let host = box_mesh([-4.0, -0.125, -2.0], [4.0, 0.125, top]);
    let cut = ([-3.5, -1.0, 0.0], [-2.5, 1.0, opening_top]);
    let mut stats = RectFastStats::default();
    assert!(
        subtract_rect_openings(&host, &[cut], &mut stats).is_none(),
        "a one-grid flush-head gap must defer instead of emitting a ghost cap"
    );
    assert_eq!(stats.defer_near_edge, 1);
    assert_eq!(stats.fired, 0);
}

#[test]
fn issue_7292_next_larger_head_grid_interval_and_exact_flush_stay_eligible() {
    let top = 2.1500091552734375;
    let host = box_mesh([-4.0, -0.125, -2.0], [4.0, 0.125, top]);
    // Snapped coordinates advance in whole grid steps: two steps are the
    // next distinct interval above the refused one-step boundary. Exact
    // equality still deduplicates, rather than refusing a genuine notch.
    for gap in [0.0, 2.0 * SNAP_GRID] {
        let cut = ([-3.5, -1.0, 0.0], [-2.5, 1.0, top - gap]);
        let mut stats = RectFastStats::default();
        let result = subtract_rect_openings(&host, &[cut], &mut stats)
            .expect("exact flush and the next larger grid interval stay eligible");
        assert_eq!(stats.defer_near_edge, 0);
        assert_eq!(stats.fired, 1);
        assert_eq!(open_edges(&result), 0);
        assert_eq!(degenerate(&result), 0);
    }
}

#[test]
fn deterministic_output() {
    let base = [10.0, 5.0, 2.0];
    let ops = [opening(base, 1.5, 2.5, 0.5, 2.0)];
    let mut s1 = RectFastStats::default();
    let mut s2 = RectFastStats::default();
    let a = subtract_rect_openings(&wall(base), &ops, &mut s1).unwrap();
    let b = subtract_rect_openings(&wall(base), &ops, &mut s2).unwrap();
    assert_eq!(a.positions, b.positions);
    assert_eq!(a.indices, b.indices);
}

#[test]
fn redundant_whole_wall_opening_defers() {
    // #1167: a double-encoded void (#964) whose box CONTAINS the whole wall
    // — full width × full height, through the thickness. The exact kernel
    // treats this as a no-op (coplanar cutter → host unchanged), so the fast
    // path MUST defer; cutting it would erase the entire wall and leave the
    // window floating in a giant void.
    let base = [10.0, 5.0, 2.0];
    let whole = opening(base, 0.0, 4.0, 0.0, 3.0); // spans the full 4 m × 3 m face
    let mut st = RectFastStats::default();
    assert!(
        subtract_rect_openings(&wall(base), &[whole], &mut st).is_none(),
        "opening that contains the whole host must defer, not erase the wall"
    );
    assert_eq!(st.defer_off_face, 1);

    // A whole-wall opening MIXED with a genuine window still defers the host
    // (the redundant void poisons the batch → hand the whole element to the
    // exact path, which cuts the real window and no-ops the redundant one).
    let mut st_mix = RectFastStats::default();
    assert!(
        subtract_rect_openings(
            &wall(base),
            &[whole, opening(base, 0.5, 1.5, 0.4, 2.6)],
            &mut st_mix
        )
        .is_none(),
        "a redundant whole-wall opening must defer the whole host"
    );

    // Sanity: a genuine interior window (margin on every in-face axis) still
    // fires the fast path — the guard is not over-broad.
    let mut st_ok = RectFastStats::default();
    assert!(
        subtract_rect_openings(&wall(base), &[opening(base, 0.5, 3.5, 0.4, 2.6)], &mut st_ok)
            .is_some(),
        "an interior window must still fire the fast path"
    );
}
