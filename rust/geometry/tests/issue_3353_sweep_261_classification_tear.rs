// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353: a CLASSIFICATION-level boolean tear on an overlapping,
//! rotated operand pair — distinct from the consolidation-level tear
//! `issue_3353_boolean_tear.rs` (PR #3388) pins.
//!
//! This case (`sweep_261`) was recovered from
//! `upstream/fix-3353-boolean-tearing`
//! (`rust/geometry/tests/issue_3353_rotated_overlap_tearing.rs`, PR #3373,
//! now closed) — its operands were never committed to `main`, so
//! classification-level work on #3353 could not previously be judged by any
//! test in this repo.
//!
//! ## Why this is classification-level, not consolidation-level
//!
//! `issue_3353_boolean_tear.rs` pins a tear that `consolidate_coplanar`
//! (`rust/geometry/src/csg/consolidate.rs`) INTRODUCES on top of a raw
//! kernel output that was already watertight. `sweep_261` is different: the
//! raw kernel output (`kernel::mesh_bridge::union`) is ALREADY
//! non-manifold, and `consolidate_coplanar` is a byte-identical no-op on
//! it — confirmed directly against the crate's private `consolidate_coplanar`
//! and `kernel::mesh_bridge::union`:
//!
//! ```text
//! raw_positions=747 raw_indices=249 cons_positions=747 cons_indices=249
//! positions_eq=true indices_eq=true
//! raw_open=3 cons_open=3
//! public_union_open_edges=3
//! ```
//!
//! i.e. `consolidate_coplanar(raw.clone())` returns a mesh whose `positions`
//! and `indices` vectors are EQUAL, element-for-element, to `raw`'s — it
//! never runs a re-triangulation pass on this input at all (or its output
//! happens to be identical), so it cannot be the source of the tear. The
//! defect is upstream, in the exact arrangement's classification step
//! (`rust/geometry/src/kernel/arrangement/classify.rs`): a prior
//! instrumented run recorded `arr.unrecovered == 0` (the arrangement
//! recovers every input triangle — this is NOT a missing-constraint
//! failure) alongside non-manifold SYMBOLIC edges in pure Vid-space, before
//! any float geometry is emitted:
//! `[((13,17),1), ((14,17),3), ((13,14),3)]` — i.e. the classification
//! verdict itself keeps an edge used once, and another used three times,
//! among the *kept* triangles, independent of position/consolidation.
//!
//! A recent attempt at #3353 was mis-scoped against `issue_3353_boolean_tear`
//! precisely because no classification-level fixture existed in the repo:
//! instrumentation on that test showed `a_hits=0, b_hits=0` — the
//! coincident-face classification regime this case exercises never fires
//! there.
//!
//! ## Status
//!
//! `#[ignore]`d: this documents a KNOWN, OPEN defect, not a passing
//! invariant. Do not un-ignore it without first fixing the classification
//! disagreement referenced above and re-validating with the full
//! `triangulation_invariance` census (see AGENTS.md). Verified to fail
//! for the stated reason (3 unmatched directed edges) when run with
//! `--ignored`.
//!
//! Refs #3353

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// Outward-wound axis-aligned box, optionally rigidly rotated about `about`.
/// Diagonal-split tessellation (matches the recovered fixture's `boxed`
/// helper) — NOT the kernel's own `box_mesh` tessellation, which splits the
/// two quads the other way and would move every face centroid enough that
/// this pinned case stops reproducing.
fn boxed(min: [f64; 3], size: [f64; 3], rot: Option<(Vector3<f64>, f64, [f64; 3])>) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let mut corners: Vec<Point3<f64>> = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    if let Some((axis, angle, about)) = rot {
        let r = Rotation3::from_axis_angle(&Unit::new_normalize(axis), angle);
        let o = Point3::new(about[0], about[1], about[2]);
        for p in corners.iter_mut() {
            *p = o + r * (*p - o);
        }
    }
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// Watertightness, counting the two directions SEPARATELY after welding by
/// position at 0.1 mm. A net-signed tally can cancel a real non-manifold
/// seam to zero (the same finding this repo already records for
/// `processors/boolean/chain_cycle_tests.rs`), so every undirected edge
/// must be used exactly once forward and once reverse.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("host was deleted entirely".to_string());
    }
    let welded = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}

/// `sweep_261`, recovered verbatim from PR #3373's closed branch.
#[test]
#[ignore = "known-open #3353 defect: classification-level tear, consolidate_coplanar \
            is a byte-identical no-op on this input (see module doc)"]
fn sweep_261_overlapping_rotated_union_never_tears() {
    let a_min = [-1.72371594746207, -0.35246108913603935, -1.2204342720208154];
    let a_size = [2.8534163464770894, 3.0795194627753784, 2.858202766048261];
    let b_min = [-2.5947221996202225, 0.7995282321488091, -1.1895637752048271];
    let b_size = [3.215043208338911, 0.9570224289084479, 3.548848436777412];
    let axis = [0.413429423622099, -0.8221765971936017, -0.6789513492042303];
    let angle = 1.3791241095493956;

    let a = boxed(a_min, a_size, None);
    let about = [
        b_min[0] + b_size[0] / 2.0,
        b_min[1] + b_size[1] / 2.0,
        b_min[2] + b_size[2] / 2.0,
    ];
    let b = boxed(
        b_min,
        b_size,
        Some((Vector3::new(axis[0], axis[1], axis[2]), angle, about)),
    );

    assert_eq!(open_edges(&a), Ok(0), "operand A must be closed going in");
    assert_eq!(open_edges(&b), Ok(0), "operand B must be closed going in");

    let clipper = ClippingProcessor::new();
    let out = clipper.union_mesh(&a, &b).expect("union must not error");
    assert_eq!(
        open_edges(&out),
        Ok(0),
        "a closed-in operand pair must come back closed-out (sweep_261, Union)"
    );
}
