// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3913: a COMMITTED, deterministic sweep harness for the `union_many`
//! N-ary residual left after the #3912 weld. #3913's own numbers (294 on
//! `main`, 88 after the weld) came from an uncommitted local script — every
//! prior figure in this defect family (#3874's 2090->0 / 2388->0 pairwise
//! sweeps, its prose-only "105 of 147" three-box counts, and #3913's own
//! 294/88) was produced the same throwaway way, so nothing here is
//! reproducible or regression-testable from an earlier PR. This file exists
//! to fix that: every number this file's tests print comes from THIS
//! committed code, run by `cargo test`, forever.
//!
//! ## Shape: reproducing #3913's "441 configurations"
//!
//! #3913 measured a "7x7 corner grid x 3 dz values x 3 operand orderings"
//! sweep over `union_many`. This harness reproduces that shape exactly:
//!
//! - **7x7 corner grid**: `three_boxes_at(bx, by, dz)` below extends
//!   `mesh_bridge_tests::issue_3353_nary_near_coplanar::three_boxes` (the
//!   pinned #3353 N-ary fixture: A axis-aligned at the origin, B rotated +30
//!   degrees about Z overlapping A's +X+Y corner, C rotated -20 degrees
//!   overlapping A's -X+Y corner) by letting B and C's corner offset `(bx,
//!   by)` vary instead of sitting fixed at `(0.4, 0.4)`. `CORNER_OFFSETS`
//!   below is 7 values spanning a shallow-to-deep overlap range, swept on
//!   both axes: 7x7 = 49 corner positions.
//! - **3 dz values**: `DZ_VALUES` samples the exactly-flush case (`dz = 0`,
//!   `three_boxes`'s own control) plus one `SNAP_GRID` step in EACH
//!   direction (`+SG`, `-SG`) — `three_boxes`'s doc names the one-step-off
//!   regime as the one that tears, and sampling both signs (rather than only
//!   `+SG`, which is all the pinned fixture checks) lets the sweep below
//!   answer #3913's "does a `dz` sign correlate with tearing" question
//!   directly, instead of only being able to speculate about the untested
//!   sign.
//! - **6 operand orderings**: `three_boxes_at` returns `[a, b, c]` in a fixed
//!   spatial arrangement; `ORDERINGS` permutes which mesh `union_many` sees
//!   first/second/third. The pinned #3353 fixture checks all 6 permutations
//!   and so does this sweep: `[A,B,C]` (identity), `[A,C,B]`, `[B,A,C]`,
//!   `[B,C,A]`, `[C,A,B]`, and `[C,B,A]` (full reversal). The full set
//!   answers whether the #3912 weld's observed `BCA => 0` is genuinely special
//!   or an artefact of sampling only 3 of 6.
//!   (`promote_operands_mutually` walks operands in index order per
//!   #3912's PR description, so which mesh is index 0 is a plausible axis of
//!   asymmetry, not an arbitrary choice).
//!
//! 7 x 7 x 3 x 6 = 882.
//!
//! ## Determinism
//!
//! Every configuration is a pure function of its `(bx, by, dz, ordering)`
//! grid indices - no RNG anywhere in this file (unlike
//! `issue_3353_unrecovered_crosstab.rs`'s splitmix64 sweeps). `union_many`
//! and `consolidate_coplanar` are themselves pure functions of their input
//! triangles computed in exact/rational arithmetic (see the kernel's own
//! determinism documentation), so the same 441 configurations produce the
//! same per-configuration tear verdict on every run, on every platform - the
//! same guarantee `mesh_determinism.json` pins for the mesh pipeline at
//! large. No wall-clock, thread count, or memory layout enters the
//! computation.
//!
//! ## CI wiring
//!
//! `union_many_nary_sweep_regression_gate` (below) is NOT `#[ignore]`d: it
//! runs on every `cargo test -p ifc-lite-geometry` / `cargo test --workspace`
//! (measured locally at well under a second for all 441 configurations - see
//! that test's doc comment for the actual timing). A harness nothing runs is
//! exactly the "gate nobody turns" failure `scripts/check-test-wiring.mjs`
//! exists to catch; being fast enough to run by default avoids needing that
//! opt-in at all.
//!
//! ## Verification (this harness actually detects tearing)
//!
//! `open_edges` below is the same "weld by position, count directed edge
//! uses per undirected edge, flag anything other than exactly (1, 1)"
//! convention `issue_3353_nary_near_coplanar::open_edges` and
//! `issue_3353_unrecovered_crosstab.rs::open_edges` already use, so it is not
//! a new, unverified detector - see `csg_property_test.rs`'s
//! `watertight_checker_rejects_non_manifold_and_open_meshes` for the standing
//! proof that this exact check-shape (implemented independently there)
//! rejects both a duplicated-shell false-negative and a plain open mesh.
//! `sweep_self_check_open_edges_detects_known_bad_meshes` below re-proves the
//! same two cases against THIS file's copy directly, since each
//! `issue_3353_*`/`issue_3913_*` file keeps its own copy rather than sharing
//! one (see `issue_3353_unrecovered_crosstab.rs`'s module doc for why no
//! shared sweep-generator module exists in this repo).
//!
//! Refs #3913, #3353, #3912, #3874

use crate::kernel::mesh_bridge::union_many;
use crate::csg::ClippingProcessor;
use crate::Mesh;
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// `SNAP_GRID`, spelled out so `DZ_VALUES` is visibly scaled to the grid -
/// same constant `issue_3353_nary_near_coplanar` names `SG`.
const SG: f64 = 1.0 / 65536.0;

/// Outward-wound axis-aligned box, optionally rigidly rotated about `about`.
/// Verbatim copy of `issue_3353_nary_near_coplanar::boxed` (itself matching
/// `issue_3353_unrecovered_crosstab.rs`'s copy) - each `issue_3353_*`/
/// `issue_3913_*` file keeps its own per that file's documented convention,
/// rather than a shared module nothing else in the repo provides.
fn boxed(min: [f64; 3], size: [f64; 3], rot: Option<(Vector3<f64>, f64, [f64; 3])>) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let mut corners: Vec<Point3<f64>> = [
        (0, 0, 0),
        (1, 0, 0),
        (1, 1, 0),
        (0, 1, 0),
        (0, 0, 1),
        (1, 0, 1),
        (1, 1, 1),
        (0, 1, 1),
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
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
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

/// Unmatched directed edges after welding by position at 0.1 mm - identical
/// convention to `issue_3353_nary_near_coplanar::open_edges`. `Err` covers
/// both "union produced nothing" and "a triangle degenerated to a repeated
/// welded vertex", both of which are tears (an empty or degenerate union of
/// three closed, disjoint-from-empty boxes is never correct), so callers
/// treat `Err` the same as `Ok(n > 0)`.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("union produced nothing".to_string());
    }
    let w = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for t in w.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
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

/// Self-check on `open_edges` itself, mirroring
/// `csg_property_test.rs::watertight_checker_rejects_non_manifold_and_open_meshes`:
/// a closed box is clean, a duplicated shell (signed edge counts cancel, but
/// every edge has 4 total directed uses) is rejected, and an open mesh (one
/// triangle removed) is rejected. Proves this file's copy of the detector
/// actually detects both failure shapes, not merely "runs without panicking"
/// - the verification bar #3913 asks for.
#[test]
fn sweep_self_check_open_edges_detects_known_bad_meshes() {
    let closed = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    assert_eq!(open_edges(&closed), Ok(0), "a plain closed box must be clean");

    let mut doubled = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let tris = doubled.indices.clone();
    for tri in tris.chunks_exact(3) {
        doubled.add_triangle(tri[0], tri[1], tri[2]);
    }
    assert_ne!(
        open_edges(&doubled),
        Ok(0),
        "a duplicated shell must be rejected (signed cancellation alone would pass it)"
    );

    let mut open = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    open.indices.truncate(open.indices.len() - 3);
    assert_ne!(
        open_edges(&open),
        Ok(0),
        "an open mesh (one triangle removed) must be rejected"
    );
}

/// A axis-aligned at the origin; B rotated +30 degrees about Z overlapping
/// its corner at offset `(bx, by)`; C rotated -20 degrees overlapping the
/// mirrored corner at `(-bx, by)`. Both rotated boxes sit `dz` above A.
/// Extends `issue_3353_nary_near_coplanar::three_boxes` (which fixes
/// `bx = by = 0.4`) by letting the corner offset vary — see the module doc
/// for why.
fn three_boxes_at(bx: f64, by: f64, dz: f64) -> [Mesh; 3] {
    let a = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let b = boxed(
        [bx, by, dz],
        [1.0, 1.0, 1.0],
        Some((
            Vector3::z(),
            30.0f64.to_radians(),
            [bx + 0.5, by + 0.5, 0.5 + dz],
        )),
    );
    let c = boxed(
        [-bx, by, dz],
        [1.0, 1.0, 1.0],
        Some((
            Vector3::z(),
            -20.0f64.to_radians(),
            [-bx + 0.5, by + 0.5, 0.5 + dz],
        )),
    );
    [a, b, c]
}

/// 7 corner-grid steps, shallow to deep overlap (a=1x1x1 boxes, so an offset
/// approaching 1.0 leaves almost no overlap and an offset near 0 is a very
/// deep overlap). Matches #3913's "7x7 corner grid".
const CORNER_OFFSETS: [f64; 7] = [0.1, 0.2, 0.35, 0.4, 0.5, 0.65, 0.8];

/// 3 `dz` values: exactly flush (the `three_boxes` control) and one snap
/// step in EACH direction. See the module doc for why both signs are swept.
const DZ_VALUES: [f64; 3] = [0.0, SG, -SG];
const DZ_LABELS: [&str; 3] = ["flush", "+1snap", "-1snap"];

/// All 6 permutations of the three operands `union_many` can see, in
/// standard permutation order. See the module doc.
const ORDERINGS: [[usize; 3]; 6] = [
    [0, 1, 2], // ABC
    [0, 2, 1], // ACB
    [1, 0, 2], // BAC
    [1, 2, 0], // BCA
    [2, 0, 1], // CAB
    [2, 1, 0], // CBA
];
const ORDERING_LABELS: [&str; 6] = ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"];

/// One sweep configuration's verdict.
struct Verdict {
    bx_idx: usize,
    by_idx: usize,
    dz_idx: usize,
    order_idx: usize,
    torn: bool,
    detail: String,
}

/// Runs the full 882-configuration sweep and returns every verdict, in
/// deterministic enumeration order (bx outer, by, dz, ordering inner).
/// Shared by the CI gate test and can be driven standalone (e.g. from a
/// `#[test] #[ignore]` or a future `examples/` binary) to print just the
/// torn subset.
fn run_sweep() -> Vec<Verdict> {
    let mut out = Vec::with_capacity(882);
    for (bx_idx, &bx) in CORNER_OFFSETS.iter().enumerate() {
        for (by_idx, &by) in CORNER_OFFSETS.iter().enumerate() {
            for (dz_idx, &dz) in DZ_VALUES.iter().enumerate() {
                let boxes = three_boxes_at(bx, by, dz);
                for (order_idx, order) in ORDERINGS.iter().enumerate() {
                    let refs: [&Mesh; 3] =
                        [&boxes[order[0]], &boxes[order[1]], &boxes[order[2]]];
                    let raw = union_many(&refs);
                    let out_mesh = ClippingProcessor::consolidate_coplanar(raw);
                    let (torn, detail) = match open_edges(&out_mesh) {
                        Ok(0) => (false, String::new()),
                        Ok(n) => (true, format!("{n} unmatched directed edge(s)")),
                        Err(e) => (true, e),
                    };
                    out.push(Verdict {
                        bx_idx,
                        by_idx,
                        dz_idx,
                        order_idx,
                        torn,
                        detail,
                    });
                }
            }
        }
    }
    out
}

/// The shipped #3912 N-ary weld measured 136 / 882 torn configurations.
/// #3925 preserves that union path; the unshipped raw-first experiment improved
/// this synthetic sweep but regressed real large-model cuts and was discarded.
/// Tighten the pre-weld ceiling of 498 to the measured shipped result.
const KNOWN_TORN_CEILING: usize = 136;

/// The primary #3913 deliverable: a committed, deterministic, CI-run sweep
/// over the exact 882-configuration shape (7x7 corner grid x 3 dz x 6
/// orderings) #3913 measured with an uncommitted script (extended from 3 to
/// all 6 permutations to answer whether the #3912 weld's `BCA => 0` is
/// genuinely special or an artefact). Reports how many of the 882
/// configurations tear, breaks the torn set down by `dz` sign and by
/// operand ordering (#3913's suggested characterisation axes), and asserts
/// the count has not REGRESSED past `KNOWN_TORN_CEILING` - not that it is
/// zero, since a fix is not required and #3913 documents this residual as a
/// known, currently-unfixed defect.
///
/// Not `#[ignore]`d: measured locally at 882 `union_many` + consolidate
/// calls over 3 twelve-triangle boxes each, taking ~2.6 seconds total wall
/// time (`cargo test -p ifc-lite-geometry --lib
/// kernel::issue_3913_sweep_tests -- --nocapture`), so it runs on every
/// `cargo test -p ifc-lite-geometry` / `cargo test --workspace` like any
/// other fast unit test - no opt-in needed.
#[test]
fn union_many_nary_sweep_regression_gate() {
    let verdicts = run_sweep();
    assert_eq!(verdicts.len(), 882, "sweep must enumerate exactly 882 configurations");

    let torn: Vec<&Verdict> = verdicts.iter().filter(|v| v.torn).collect();

    // Characterisation: torn count broken down by dz sign/label.
    let mut by_dz = [0usize; 3];
    for v in &torn {
        by_dz[v.dz_idx] += 1;
    }
    // Characterisation: torn count broken down by operand ordering.
    let mut by_order = [0usize; 6];
    for v in &torn {
        by_order[v.order_idx] += 1;
    }

    let mut report = format!(
        "issue #3913 union_many N-ary sweep: {} / {} configurations torn\n\
         by dz:      {}={:<4} {}={:<4} {}={}\n\
         by order:   {}={:<4} {}={:<4} {}={:<4} {}={:<4} {}={:<4} {}={}\n",
        torn.len(),
        verdicts.len(),
        DZ_LABELS[0], by_dz[0], DZ_LABELS[1], by_dz[1], DZ_LABELS[2], by_dz[2],
        ORDERING_LABELS[0], by_order[0], ORDERING_LABELS[1], by_order[1],
        ORDERING_LABELS[2], by_order[2], ORDERING_LABELS[3], by_order[3],
        ORDERING_LABELS[4], by_order[4], ORDERING_LABELS[5], by_order[5],
    );
    for v in &torn {
        report.push_str(&format!(
            "  torn: bx={:.2} by={:.2} dz={} order={} :: {}\n",
            CORNER_OFFSETS[v.bx_idx],
            CORNER_OFFSETS[v.by_idx],
            DZ_LABELS[v.dz_idx],
            ORDERING_LABELS[v.order_idx],
            v.detail,
        ));
    }
    println!("{report}");

    assert!(
        torn.len() <= KNOWN_TORN_CEILING,
        "{report}\n{} of 882 configurations tore, exceeding the recorded ceiling of {} \
         (issue #3913) — this is a REGRESSION, not the known residual. Do not raise \
         KNOWN_TORN_CEILING to force a pass; find what changed.",
        torn.len(),
        KNOWN_TORN_CEILING,
    );
}
