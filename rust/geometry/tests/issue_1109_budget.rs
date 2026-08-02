// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1109 regression: the per-element CSG escalation budget bounds a pathological
//! element's exact work so a boolean-heavy element finishes (degraded) instead of
//! hanging at 95%, AND a single boolean can't overshoot the cap unboundedly.
//!
//! This exercises the guardrail on REAL CSG (the arrangement + retriangulation
//! exact-predicate cascade), not just the synthetic counters of the budget unit
//! test. It is deterministic and fixture-free: the escalation count is a pure
//! function of the (snap-grid) operands, so the asserted bounds hold byte-
//! identically on native x86_64/aarch64 and wasm32.
//!
//! These tests mutate the global budget caps, so the file holds exactly ONE
//! `#[test]` (cargo runs each integration-test file as its own process; tests
//! WITHIN a file share the process and would race on the global cap).

use ifc_lite_geometry::kernel::budget;
use ifc_lite_geometry::mesh::Mesh;
use ifc_lite_geometry::ClippingProcessor;

/// Axis-aligned box [min,max] as a 12-triangle `Mesh`.
fn box_mesh(min: [f32; 3], max: [f32; 3]) -> Mesh {
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
    let mut positions = Vec::new();
    for v in &c {
        positions.extend_from_slice(v);
    }
    let indices: Vec<u32> = vec![
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5,
        0, 4, 7, 0, 7, 3,
    ];
    Mesh {
        positions,
        normals: Vec::new(),
        indices,
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None }
}

/// A faceted "half-space" slab whose top face is tessellated into `n`×`n` quads,
/// all coplanar at `ztop`. Cutting a host with this drives the exact predicate
/// cascade hard (the coplanar-fragment retriangulation of #1109). Closed into a
/// solid with a skirt + bottom; winding is fixed by the kernel's `orient_outward`.
fn faceted_slab(min: [f32; 3], max: [f32; 3], n: usize, z_top: f32) -> Mesh {
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let push = |p: [f32; 3], positions: &mut Vec<f32>| -> u32 {
        let idx = (positions.len() / 3) as u32;
        positions.extend_from_slice(&p);
        idx
    };
    let (x0, y0, z0) = (min[0], min[1], min[2]);
    let (x1, y1) = (max[0], max[1]);
    let mut grid = vec![0u32; (n + 1) * (n + 1)];
    for j in 0..=n {
        for i in 0..=n {
            let fx = x0 + (x1 - x0) * (i as f32 / n as f32);
            let fy = y0 + (y1 - y0) * (j as f32 / n as f32);
            grid[j * (n + 1) + i] = push([fx, fy, z_top], &mut positions);
        }
    }
    for j in 0..n {
        for i in 0..n {
            let a = grid[j * (n + 1) + i];
            let b = grid[j * (n + 1) + i + 1];
            let c = grid[(j + 1) * (n + 1) + i + 1];
            let d = grid[(j + 1) * (n + 1) + i];
            indices.extend_from_slice(&[a, b, c, a, c, d]);
        }
    }
    let bl = [
        push([x0, y0, z0], &mut positions),
        push([x1, y0, z0], &mut positions),
        push([x1, y1, z0], &mut positions),
        push([x0, y1, z0], &mut positions),
    ];
    indices.extend_from_slice(&[bl[0], bl[2], bl[1], bl[0], bl[3], bl[2]]);
    let tb = |i: usize, j: usize| grid[j * (n + 1) + i];
    for i in 0..n {
        indices.extend_from_slice(&[bl[0], bl[1], tb(i + 1, 0), bl[0], tb(i + 1, 0), tb(i, 0)]);
        indices.extend_from_slice(&[bl[3], tb(i, n), tb(i + 1, n), bl[3], tb(i + 1, n), bl[2]]);
    }
    for j in 0..n {
        indices.extend_from_slice(&[bl[0], tb(0, j), tb(0, j + 1), bl[0], tb(0, j + 1), bl[3]]);
        indices.extend_from_slice(&[bl[1], tb(n, j + 1), tb(n, j), bl[1], bl[2], tb(n, j + 1)]);
    }
    Mesh {
        positions,
        normals: Vec::new(),
        indices,
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None }
}

/// Total exact-tier escalations a sequence of cuts drives, under whatever caps are
/// currently set, within ONE element scope. Mirrors the production per-element
/// path: `begin_element()` once, then `ClippingProcessor::subtract_mesh` per
/// cutter — which is where the budget bail lives: on a trip it returns the host
/// UN-CUT (the #635 AABB fallback fires from there in prod), so the result stays
/// valid geometry rather than the raw kernel's partial arrangement.
fn element_escalations(host: &Mesh, cutters: &[Mesh]) -> (u64, Mesh) {
    let proc = ClippingProcessor::new();
    budget::begin_element();
    let mut result = host.clone();
    for c in cutters {
        if let Ok(m) = proc.subtract_mesh(&result, c) {
            result = m;
        }
    }
    (budget::element_count(), result)
}

#[test]
fn issue_1109_per_element_budget_bounds_pathological_csg() {
    // A host slab cut by several coplanar-fragment slabs at staggered internal
    // heights — the dense-coplanar-cut pattern that hung the exact kernel.
    let host = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let cutters: Vec<Mesh> = (0..5)
        .map(|k| {
            let z = 1.0 + k as f32 * 1.5;
            faceted_slab([-1.0, -1.0, -1.0], [11.0, 11.0, z], 40, z)
        })
        .collect();

    // 1. UNBOUNDED — how much exact work does this element REALLY need? (This is
    //    the cost that hung the stream before the budget existed.)
    budget::set_cap(None);
    budget::set_element_cap(None);
    let (unbounded, _) = element_escalations(&host, &cutters);
    assert!(
        unbounded > 60_000,
        "the test element must be genuinely pathological (drive >60k exact \
         escalations unbounded); got {unbounded} — strengthen the cutters"
    );

    // 2. BOUNDED — the per-element budget caps the exact work near the cap. The
    //    overshoot guards inside the retriangulation loops keep a single boolean
    //    from blowing past it by orders of magnitude (the pre-fix failure: one
    //    boolean ran to 7.7M escalations = 15x a 500k cap before bailing).
    const ELEM_CAP: u64 = 40_000;
    budget::set_cap(Some(budget::DEFAULT_CAP));
    budget::set_element_cap(Some(ELEM_CAP));
    let (bounded, result) = element_escalations(&host, &cutters);
    eprintln!("#1109 budget test: unbounded={unbounded} bounded={bounded} (cap={ELEM_CAP})");

    // The element's total exact work is bounded near the cap, NOT the unbounded
    // cost: without the overshoot guard a single boolean ran ~15x past the cap.
    assert!(
        bounded < ELEM_CAP * 2,
        "per-element budget must bound escalations near the cap ({ELEM_CAP}); \
         got {bounded} (unbounded was {unbounded})"
    );
    assert!(
        bounded < unbounded,
        "the budget must cut the work short of the unbounded cost \
         (bounded={bounded}, unbounded={unbounded})"
    );

    // 3. The degraded output is still VALID geometry (finite, non-empty), not
    //    corrupt — a bailed cut leaves the host un-cut / AABB-boxed, never NaN.
    assert!(!result.positions.is_empty(), "degraded element must still produce geometry");
    assert!(
        result.positions.iter().all(|c| c.is_finite()),
        "degraded element must not emit non-finite coordinates"
    );

    // Restore the shipped defaults for hygiene (single-test file, but be tidy).
    budget::set_cap(Some(budget::DEFAULT_CAP));
    budget::set_element_cap(Some(budget::DEFAULT_ELEMENT_CAP));
}
