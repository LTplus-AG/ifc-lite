// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353 (`sweep_261`), Vid-space instrument — NOT a fix.
//!
//! `issue_3353_sweep_261_classification_tear.rs` (a `tests/` integration
//! test, `#[ignore]`d because it documents a known-open defect) records that
//! a prior instrumented run found, for this exact operand pair under
//! `Union`: `arr.unrecovered == 0` (the arrangement fully recovers every
//! input constraint — not a missing-constraint failure) alongside a
//! KEPT-triangle set that is non-manifold in pure Vid space, before any
//! float geometry is emitted — the undirected edges `(13,17)` used once and
//! `(14,17)`/`(13,14)` each used three times among the triangles
//! `boolean_vids` decided to KEEP.
//!
//! This module turns that one-off instrumented run into a standing,
//! re-runnable measurement.
//!
//! ## Why this cannot be a `tests/` integration test
//!
//! `boolean_vids`/`boolean_vids_components`/`BComponents` are declared
//! `pub(super) ` in `classify.rs` — visible only inside `kernel::arrangement`
//! (`classify.rs`'s parent module) and its descendants, never outside this
//! crate. Separately, the production entry points
//! (`kernel::mesh_bridge::union`/`boolean`) orient each operand with
//! `kernel::mesh_bridge::orient_outward`, which is `pub(crate)` — also
//! unreachable from an external integration-test crate. Both gaps close for
//! an in-crate `#[cfg(test)]` module, which is why this file is wired in
//! with the same `#[path = "..."] mod ...;` mechanism `classify_tests.rs`
//! already uses (see the bottom of `classify.rs`), rather than living under
//! `rust/geometry/tests/`.
//!
//! ## What this measures
//!
//! For the `sweep_261` operand pair, reproduced via the SAME construction
//! `kernel::mesh_bridge::union` runs internally
//! (`orient_outward(mesh_to_tris(mesh))` on each operand, then `arrange`,
//! then `boolean_vids`) rather than a hand-rolled substitute for either
//! step:
//!
//! 1. The kept-triangle Vid set `boolean_vids` returns, before
//!    `to_f64_pt`/consolidation ever run.
//! 2. An undirected-edge census over those kept triangles in Vid space:
//!    every edge's usage count, and specifically every edge whose count is
//!    not exactly 2 — the Vid-space analogue of the `open_edges` check the
//!    sibling `tests/issue_3353_*` files run on FLOAT geometry, run here one
//!    layer earlier, on the symbolic triangles `boolean_vids` decided to
//!    keep.
//! 3. Per over-used edge, which kept triangles share it and which operand
//!    (A or B) each came from — origin is recovered by exact (unrotated)
//!    membership against `arr.tris_a`/`arr.tris_b`, not by re-deriving
//!    classification (see `origin_of`'s doc comment for why this is valid
//!    for `Union`).
//!
//! ## Deliberately NOT changed
//!
//! No production function's signature, behaviour, or visibility changes.
//! This file only CALLS existing `pub(super)`/`pub(crate)` functions from a
//! new vantage point and post-processes their unmodified return values.
//!
//! ## CI-visible pin, not a `#[ignore]`d printout
//!
//! `sweep_261_kept_triangles_are_nonmanifold_in_vid_space` (below) runs in
//! normal `cargo test` (no `--ignored`) and asserts the DEFECT SHAPE
//! described above: `unrecovered == 0` together with at least one
//! kept-triangle edge whose Vid-space multiplicity is not 2.
//!
//! It deliberately does NOT assert the exact Vid numbers
//! `(13,17)`/`(14,17)`/`(13,14)` quoted above from the sibling file's doc
//! comment — those are Vid-interner allocation labels, not geometry, and
//! this file's reproduction was not executed against that prior run before
//! this patch was written (no `cargo test` was run to produce this file —
//! the workstation that wrote it was disk-constrained and cargo was
//! off-limits). Pinning unverified literals would risk failing on the very
//! first CI run for a labelling reason unrelated to the defect. The full
//! kept set and edge census ARE printed (`--nocapture`) so that first CI
//! run's output becomes the first VERIFIED record of the exact numbers,
//! which can be pinned in a follow-up if wanted.
//!
//! This is a characterisation pin of a KNOWN-DEFECTIVE state, not a health
//! check: a green tick on this test means "the defect still reproduces
//! exactly as documented," NOT "issue #3353 is fixed." Read together with
//! `sweep_261_overlapping_rotated_union_never_tears`'s `#[ignore]` in the
//! sibling file (which this patch does not touch and does not un-ignore),
//! the pair is meant to be unambiguous: that file documents the defect
//! end-to-end (ignored, because it fails outright), this one documents its
//! Vid-space signature (not ignored, because — until the defect is fixed —
//! it is expected to keep finding one). If `classify.rs` changes and this
//! test starts failing, that is the expected trigger to re-diagnose BOTH
//! files together, not to loosen either assertion.
//!
//! Refs #3353

use super::boolean_vids;
use crate::kernel::arrangement::{arrange, Arrangement, BoolOp, Tri};
use crate::kernel::interner::Vid;
use crate::kernel::mesh_bridge::{mesh_to_tris, orient_outward};
use crate::mesh::Mesh;
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::{HashMap, HashSet};

/// `sweep_261`'s operand builder, verbatim from
/// `issue_3353_sweep_261_classification_tear.rs`'s `boxed()` (same
/// tessellation and corner/face order — load-bearing, per that file's doc
/// comment). Kept as a `Mesh` here (rather than emitting `Tri` directly) so
/// this file can feed it through the ACTUAL production `mesh_to_tris` +
/// `orient_outward` pair instead of duplicating their logic.
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

/// `sweep_261`'s exact operands, verbatim from
/// `issue_3353_sweep_261_classification_tear.rs`.
fn sweep_261_operands() -> (Mesh, Mesh) {
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
    (a, b)
}

/// Which operand a kept Vid triangle came from, recovered by exact
/// (unrotated) membership against `arr.tris_a`/`arr.tris_b` rather than by
/// re-deriving classification. Valid for `Union` specifically: in
/// `boolean_vids_components` (`classify.rs`), `flip` is
/// `matches!(op, BoolOp::Difference)` only, so a kept `Union` triangle is
/// always pushed VERBATIM — either a `tris_a[i]` entry unchanged, or a
/// `tris_b[i]` entry unchanged. The one case where this could be ambiguous —
/// a true co-oriented A/B duplicate face — is exactly what `Union`'s own
/// dedup (the `a_kept`/`rotate_min_first` bookkeeping in
/// `boolean_vids_components`) already collapses to the A-copy before a B
/// duplicate is ever pushed, so any triangle actually present in `kept`
/// should resolve unambiguously against one `HashSet` or the other. The
/// test body below asserts that rather than assuming it silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    A,
    B,
    /// Present in neither `arr.tris_a` nor `arr.tris_b` verbatim. Not
    /// expected to occur for `Union`; a triangle resolving to this is itself
    /// a finding, and the test body fails loudly on it rather than
    /// mislabeling it.
    Unresolved,
    /// Present in BOTH operands' sub-triangle sets — the arrangement conforms
    /// over one interner, so an interface face can be the same oriented Vid
    /// triple on both sides. Attribution is genuinely undecidable from the
    /// merged output alone.
    Both,
}

fn origin_of(tri: [Vid; 3], tris_a: &HashSet<[Vid; 3]>, tris_b: &HashSet<[Vid; 3]>) -> Origin {
    // Membership is tested against the FULL per-side sub-triangle sets, not the
    // kept subsets, because `boolean_vids` returns one merged list and does not
    // say which loop pushed each triangle. So a triangle present on both sides
    // is genuinely ambiguous here: the arrangement conforms over one interner,
    // so an interface face can be the SAME oriented Vid triple on both operands
    // (`classify.rs` says as much), and reporting `A` for it — as a first-match
    // check would — could attribute an over-used edge to the wrong operand.
    // Report the ambiguity instead of guessing; the census's pass/fail does not
    // depend on it, only the per-edge attribution does.
    match (tris_a.contains(&tri), tris_b.contains(&tri)) {
        (true, false) => Origin::A,
        (false, true) => Origin::B,
        (true, true) => Origin::Both,
        (false, false) => Origin::Unresolved,
    }
}

/// Undirected Vid-space edge census over `kept`: canonical `(min(u,v),
/// max(u,v))` -> the `(index into kept, origin)` of every triangle that uses
/// it. A triangle contributes each of its 3 edges once; an edge's count
/// reaching anything other than 2 across `kept` is exactly the symbolic
/// (pre-float) signature of a classification-level tear.
fn edge_census(
    kept: &[[Vid; 3]],
    tris_a: &HashSet<[Vid; 3]>,
    tris_b: &HashSet<[Vid; 3]>,
) -> HashMap<(Vid, Vid), Vec<(usize, Origin)>> {
    let mut edges: HashMap<(Vid, Vid), Vec<(usize, Origin)>> = HashMap::new();
    for (idx, tri) in kept.iter().enumerate() {
        let origin = origin_of(*tri, tris_a, tris_b);
        for k in 0..3 {
            let (u, v) = (tri[k], tri[(k + 1) % 3]);
            let key = (u.min(v), u.max(v));
            edges.entry(key).or_default().push((idx, origin));
        }
    }
    edges
}

/// See the module doc for the full rationale. Runs in normal `cargo test`
/// (no `--ignored`) and PINS the current, known-defective Vid-space shape:
/// a fully-recovered arrangement (`unrecovered == 0`) whose kept triangles
/// are nonetheless non-manifold in Vid space. A green tick here means "the
/// #3353 classification-level tear still reproduces exactly as documented,"
/// NOT "issue #3353 is fixed."
#[test]
fn sweep_261_kept_triangles_are_nonmanifold_in_vid_space() {
    let (mesh_a, mesh_b) = sweep_261_operands();
    // Same construction `kernel::mesh_bridge::union` runs internally, so the
    // arrangement below is the one production actually computes for this
    // pair — not a hand-rolled approximation of it.
    //
    // `budget::begin()` first, exactly as every production entry point does.
    // The #1109 escalation counters are THREAD-LOCAL and nothing else resets
    // them, so without this the arrangement below would run against whatever
    // budget state a previously-scheduled unit test happened to leave on this
    // worker thread — `kernel::budget::tests` and `router::voids::
    // flap_clip_tests` both drive that state deliberately, and they share this
    // binary. `arrange` consults `budget::tripped()` and bails at its first
    // pair when set, which would fail the `unrecovered == 0` assertion below
    // for a reason having nothing to do with #3353.
    crate::kernel::budget::begin();
    let a: Vec<Tri> = orient_outward(mesh_to_tris(&mesh_a));
    let b: Vec<Tri> = orient_outward(mesh_to_tris(&mesh_b));

    let arr: Arrangement = arrange(&a, &b);
    assert_eq!(
        arr.unrecovered, 0,
        "sweep_261's arrangement is expected to fully recover every constraint \
         (the documented premise of the #3353 classification-level tear — if this \
         now fails, the defect has moved from classification into arrangement \
         conformity, and `issue_3353_unrecovered_crosstab.rs` is the file to \
         extend, not this one)"
    );

    let kept: Vec<[Vid; 3]> = boolean_vids(&arr, &a, &b, BoolOp::Union);
    assert!(!kept.is_empty(), "sweep_261's union must keep at least one triangle");

    let tris_a: HashSet<[Vid; 3]> = arr.tris_a.iter().copied().collect();
    let tris_b: HashSet<[Vid; 3]> = arr.tris_b.iter().copied().collect();

    // Soundness guard on `origin_of`'s own claim (see its doc comment) before
    // trusting any origin tag printed or asserted below.
    for tri in &kept {
        assert_ne!(
            origin_of(*tri, &tris_a, &tris_b),
            Origin::Unresolved,
            "kept triangle {tri:?} is not verbatim present in arr.tris_a or \
             arr.tris_b — the Union-only \"never flipped\" assumption in \
             `origin_of`'s doc comment does not hold for this triangle; \
             investigate before trusting any origin tag in this test's output"
        );
    }

    let census = edge_census(&kept, &tris_a, &tris_b);
    let mut overused: Vec<(&(Vid, Vid), &Vec<(usize, Origin)>)> =
        census.iter().filter(|(_, users)| users.len() != 2).collect();
    overused.sort_by_key(|(edge, _)| **edge);

    println!("sweep_261 kept-triangle Vid set ({} triangles):", kept.len());
    for (idx, tri) in kept.iter().enumerate() {
        println!(
            "  [{idx}] {tri:?} origin={:?}",
            origin_of(*tri, &tris_a, &tris_b)
        );
    }
    println!(
        "edges with multiplicity != 2 ({} of {} total kept-triangle edges):",
        overused.len(),
        census.len()
    );
    for (edge, users) in &overused {
        println!("  {edge:?} used {} time(s) by:", users.len());
        for (idx, origin) in users.iter() {
            println!("    kept[{idx}] = {:?} origin={:?}", kept[*idx], origin);
        }
    }

    // The defect itself: a fully-recovered arrangement (asserted above)
    // whose KEPT triangles are still non-manifold in pure Vid space. See the
    // module doc for why this is a defect PIN, not a health check.
    assert!(
        !overused.is_empty(),
        "expected sweep_261's kept-triangle set to be non-manifold in Vid space \
         (issue #3353's classification-level tear) but every edge had multiplicity \
         2 — either the defect is fixed (in which case: un-ignore \
         `issue_3353_sweep_261_classification_tear.rs` too, and delete or repurpose \
         this test) or this file's reproduction no longer matches the documented \
         case and needs re-diagnosing before trusting either outcome"
    );
}
