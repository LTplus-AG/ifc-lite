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
//! ## Which regime decides each implicated triangle (measured)
//!
//! The edge census below says WHICH triangles disagree. This section records
//! WHY, from an instrumented run of `boolean_vids_components`'s own three-regime
//! chain over this exact arrangement. Every triangle on an over-used edge:
//!
//! ```text
//! edge (13,17)   A[17] [15,13,17] |n|=6.11e-1  R3 inside_b=true    keep=false
//!                A[22] [17,13,14] |n|=6.56e-5  R1 dot=1.19e-4      keep=true
//! edge (13,14)   A[15] [13,10,14] |n|=6.01e-6  R3 inside_b=false   keep=true
//!                B[17] [13,39,14] |n|=1.62e-4  R3 inside_a=true    keep=false
//!                B[18] [41,13,14] |n|=3.66e-5  R3 inside_a=false   keep=true
//! edge (14,17)   A[21] [14,11,17] |n|=1.03e0   R3 inside_b=false   keep=true
//!                B[66] [14,39,17] |n|=1.62e0   R3 inside_a=true    keep=false
//!                B[67] [42,14,17] |n|=1.15e0   R3 inside_a=false   keep=true
//! ```
//!
//! The last column is the DECIDING test, so the B rows name the ray cast that
//! actually decided them. `c_on_or_near_a` — the B loop's dedup drop, which runs
//! first — returned false for all four, so none of them reached it.
//!
//! `A[22]` is the whole defect, and it is the ONLY triangle here decided by
//! regime 1. Edge `(13,17)` is bounded by exactly two A sub-triangles, `A[17]`
//! and `A[22]`, and they lie in ONE A face plane — Vids 13, 14, 15 and 17 are
//! exactly coplanar (`orient3d == 0`, not merely within a tolerance), on the
//! plane the original `a[2]` and `a[3]` share as the diagonal split of one box
//! face. Two sub-triangles of one flat face, and they disagree: the well-formed
//! one is dropped as inside B by the ray cast, the needle is kept by the
//! coincident-face regime. Dropping `A[22]` alone repairs all three edges:
//! `(13,17)` goes to 0, since `A[22]` is its only user, and the other two to 2.
//! So it is the single wrong verdict, not a symptom of several.
//!
//! And the ray cast agrees it should be dropped. Probed directly, `A[22]` has
//! `R3 inside_b == true` and `R2 solid_side == (true, true)`: regime 1 is
//! OVERRIDING a fallback that already had the right answer.
//!
//! ## Why regime 1 fires on it, and why that is the root cause
//!
//! `classify.rs`'s `on_surface_tri`/`near_on_surface_tri` establish "this is a
//! coincident SHARED face of the other operand" from the sub-triangle's CENTROID
//! alone: on the other face's plane (or within `NearBand`) and inside its
//! outline. `boolean_vids_components` then resolves that by NORMAL AGREEMENT,
//! `dot3(tri_normal, n_other) > 0.0`.
//!
//! A sub-triangle need not have its parent's plane. Retriangulation can leave
//! one DEGENERATE onto the line where the two parent planes MEET, at which point
//! its whole extent sits within the NEAR band of the other operand's plane
//! however transversal the two faces are. (Measured: the exact
//! `on_surface_normal` returns `None` here; only `near_on_surface_normal`
//! accepts it, at 1.86e-5 off the B face.) `A[22]` is exactly that: a needle whose two ends are
//! 8.4e-5 apart, sitting on the A-B plane intersection line, centroid 1.86e-5
//! from a B face and inside its outline. So regime 1 fires on a face pair that
//! is not coincident, and resolves it by the sign of a cross product a
//! near-collinear triple does not pin down (`|own_n| = 6.56e-5` against
//! `|n_other| = 3.4`). What it happens to yield is `cos = 5.32e-1`, 58 degrees:
//! nowhere near parallel, so there is no shared face to be co-oriented with.
//!
//! ## What was tried against that, and why none of it landed
//!
//! Coincidence is a property of the two INPUT faces, so the natural fix is to
//! ask it of the sub-triangle's PARENT face: carry the originating triangle on
//! the `Arrangement` and require the whole parent to lie on, or be flush within
//! the band of, the candidate face's plane. That is exact, threshold-free, and
//! strictly stricter than the centroid test, so a genuine shared face keeps its
//! verdict. Measured, against a corpus census whose baseline matches the golden
//! exactly:
//!
//! A second shape drops out of the same reading. Only the NEAR test accepts
//! `A[22]`, and `coplanar_a[22] == false`, so gating the A-side near call on the
//! coplanar-parent flag also takes it out of regime 1 — and that is what
//! `near_on_surface_normal`'s own doc claimed the code already did.
//!
//! ```text
//!                                sweep_261   union sweep    census
//! parent-flush, A and B sides    passes      98 -> 72       39 hosts regressed
//! parent-flush, A side only      passes      98 -> 77       20 hosts regressed
//! near test gated on coplanar_a  passes      98 -> 77       20 hosts regressed
//! parent NORMAL for the dot      FAILS       not run        not run
//! flush test on the sub-tri      FAILS       not run        not run
//! parent-flush, A side, 3 verts  passes      98 -> 77       26 regressed, 9 improved
//! needle refused (area < 1e-6 parent) FAILS   98 -> 92       12 regressed, 3 improved
//! ```
//!
//! The last two rows were re-measured on 2026-09-04 with the parent index
//! carried on the `Arrangement` (patches kept off-tree). The all-vertex flush
//! gate fixes the target but also refuses the #1007 tilted-flush caps whose far
//! vertices leave the band: one host doubles its open edges (622 -> 1333) and
//! seven read "geometry lost". The needle gate is scale-free but a 1e-12 cut
//! in |n|^2 misses the very needle in `sweep_261` (its ratio is 3.7e-10), and
//! loosening it to catch that would be tuning a constant on one case. What a
//! fix still needs: a coincidence criterion that is a property of the parent
//! face yet tolerates a tilt of a few um across the face's extent, measured
//! against the corpus golden, with the 26-host row as the first thing to beat.
//!
//! (The two that fail `sweep_261` were not carried further; "not run" is not a
//! null result.)
//!
//! Why the rows read as they do:
//!
//! 1. The B side must NOT require it. `c_on_or_near_a` is a DEDUP drop, not an
//!    orientation verdict, so making coincidence harder there leaves B copies of
//!    genuinely shared faces alive next to the A copy — the 39-host run's
//!    reasons are dominated by hosts GAINING triangles and open edges.
//! 2. The sliver has to LEAVE regime 1, not be re-oriented inside it: the
//!    parent's normal gives the same sign, so substituting it changes nothing.
//! 3. Gating the near test costs MORE than the census row shows: it also breaks
//!    two pinned near-band invariants in `tests/clash_intersection_oracle.rs`,
//!    `no_surviving_near_band_triangle_has_an_x_facing_normal` and
//!    `the_near_band_shortfall_is_a_missing_face_pair_not_a_shape_dependent_wedge`,
//!    which need that path ungated. So the doc claiming the gate exists is
//!    describing an intent the corpus has since contradicted, not a lost
//!    invariant to restore.
//! 4. Both shapes that fix `sweep_261` improve every aggregate — the A-side
//!    parent-flush one reads corpus unmatched edges 17863 -> 15992, strict-rule
//!    edges 19344 -> 17612, torn hosts 165 -> 161 — while still regressing 20
//!    pinned per-host rows, most of them reading "geometry lost". That is the
//!    per-host golden doing its job: those hosts were watertight BECAUSE regime 1
//!    kept a zero-area sliver on an arbitrary sign, and they have a pre-existing
//!    tear the sliver was patching. Two independent shapes landing on the same
//!    20 is itself evidence the cost is that population, not either criterion.
//!
//! So the remaining work is not another criterion for regime 1. It is the tear
//! those hosts already carry, which today is masked. `various/rvt01.ifc` #7295,
//! #7544, #16805 and `ISSUE_129_...` #34385, #295370, #296868 are the ones that
//! lose the most geometry and are the place to start.
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
//! `(13,17)`/`(14,17)`/`(13,14)` — those are Vid-interner allocation labels,
//! not geometry, and pinning them would fail on any relabelling for a reason
//! unrelated to the defect. The assertion stays on the SHAPE.
//!
//! The original reason given here was different, and is now spent: it said this
//! file's reproduction had never been executed (no `cargo test` was run to
//! produce it — the workstation that wrote it was disk-constrained), so the
//! labels were unverified. They have since been verified. Every number in the
//! regime table above comes from an instrumented run of this exact
//! reproduction, and the labels match. Leaving the old wording in would tell
//! the next reader the table directly above it is guesswork.
//!
//! The full kept set and edge census are printed, but CI will NOT show
//! them: `.github/workflows/test.yml` runs `cargo test --workspace` with no
//! `--nocapture`, and cargo suppresses stdout for a PASSING test — which
//! this is by design while the defect exists. Confirmed absent from the
//! first green run's log rather than assumed. To read the numbers:
//!
//!   cargo test -p ifc-lite-geometry --lib issue_3353_vid_census -- --nocapture
//!
//! They have now been observed (see the regime table above); they are still
//! deliberately not pinned, for the relabelling reason given above.
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
//! ## Issue #3915: is this a vertex-IDENTITY defect? (measured, ruled out)
//!
//! #3915 asked whether the interner should be CANONICALIZING near-coincident
//! constraint-intersection vertices during per-face retriangulation, on the
//! theory that this run interns three separate Vids for what should be one
//! shared corner. Instrumented directly (`kernel::interner::Interner::intern`
//! called from THIS reproduction, positions read via `to_f64_pt`), that
//! theory does not hold:
//!
//! ```text
//! Vid 10 = [-1.7237091064453125, -0.3524627685546875, 1.6377716064453125]
//! Vid 11 = [ 1.1296997070312500, -0.3524627685546875, 1.6377716064453125]
//! Vid 13 = [-1.6740500545616240, -0.2988684570207063,  1.6377716064453125]
//! Vid 14 = [-1.6739785390123234, -0.2989121991848813,  1.6377716064453125]
//! Vid 17 = [-0.7426012079060830,  0.0489949180186103,  1.6377716064453125]
//! dist(10,11) = 2.853  dist(10,17) = 1.060  dist(11,17) = 1.915
//! ```
//!
//! Vids 10, 11 and 17 are ordinary A-face vertices, none within a metre of
//! either of the others — not a near-coincident trio. The ONLY near-coincident
//! pair in this arrangement is Vid 13 / Vid 14, 83.85 um apart (matches the
//! issue's own headline measurement exactly), and there are two of them, not
//! three. So there is no third redundant Vid for an intern-time canonical form
//! to fold away.
//!
//! What edge (13,14) actually is: a hairline retriangulation seam on A's
//! face, correctly used by TWO real triangles — `kept[11]=[13,10,14]`
//! (`A[15]`, kept by the ray cast) and `kept[56]=[41,13,14]` (`B[18]`, also
//! kept by the ray cast) — one sliver per operand, each a legitimate
//! consequence of where that operand's OWN retriangulation happened to place
//! its constraint split. Both slivers share the tiny edge because they meet
//! along it; neither vertex is spurious, and merging Vid 13 into Vid 14 (or
//! vice versa) would collapse both real slivers, not remove a duplicate.
//!
//! The edge's multiplicity is 3, not 2, because a THIRD triangle also claims
//! it: `kept[16]=[17,13,14]` (`A[22]`), the needle already named above as
//! "the whole defect" — decided by regime 1 overriding a ray cast (`R3
//! inside_b == true`) that had already rejected it correctly. That is a
//! triangle-ACCEPTANCE defect in `classify.rs`, not a vertex-IDENTITY one:
//! there is no pair of "independently-derived exact intersection points
//! denoting one logical corner" here to canonicalize. Vid 13 and Vid 14 are
//! two distinct, correctly-derived corners; the bug is that a third,
//! wrongly-accepted triangle happens to use the tiny edge between them.
//!
//! The interner itself is exonerated by its own contract (`kernel::interner`
//! module doc): "Two points that are EXACTLY coincident (`cmp_lex == Zero`)
//! get the SAME `Vid`, regardless of construction (LPI vs TPI vs Explicit) or
//! insertion order" — already construction-independent, already exercised by
//! `Interner::tests::coincident_points_weld_to_one_vid` (an LPI and a TPI at
//! the same point weld today). Vid 13 and Vid 14 do NOT collide under that
//! rule because they are not the same exact rational point; inventing a
//! second, coarser identity criterion to fold them together would need a
//! distance threshold, which is exactly the "coincidence criterion" the
//! "What was tried against that" section above already measured — at the
//! classification layer, framed as a parent-plane/parent-flush gate rather
//! than a vertex-merge — and found to regress 20 to 39 golden corpus hosts.
//! Moving the identical threshold decision into the interner does not avoid
//! that cost; it relocates it. No canonicalization is proposed here.
//!
//! Refs #3353, #3915

use super::boolean_vids;
use crate::kernel::arrangement::{arrange, Arrangement, BoolOp, Tri};
use crate::kernel::interner::Vid;
use crate::kernel::mesh_bridge::{mesh_to_tris, orient_outward};
use crate::mesh::Mesh;
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::{BTreeSet, HashMap, HashSet};

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

/// Squared Euclidean distance between two points.
fn dist2(p: [f64; 3], q: [f64; 3]) -> f64 {
    let d = super::sub_f64(p, q);
    super::dot3(d, d)
}

/// Closest point to `p` on the closed segment `[a, b]`. The zero-length case
/// is guarded explicitly: the projection divides by the squared segment
/// length, which would otherwise be `0.0 / 0.0`.
fn closest_point_on_segment3(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    let ab = super::sub_f64(b, a);
    let len2 = super::dot3(ab, ab);
    if len2 == 0.0 {
        return a;
    }
    let ap = super::sub_f64(p, a);
    let t = (super::dot3(ap, ab) / len2).clamp(0.0, 1.0);
    [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]
}

/// Closest point to `p` on the CLOSED (filled) triangle, not on its plane — a
/// centroid can be near a triangle's plane while far from the triangle itself.
/// Ericson's seven-region barycentric test. Its interior branch needs `va`,
/// `vb`, `vc` all positive, which needs strictly positive area, so a degenerate
/// triangle can never reach the final division; the guard below is explicit
/// rather than relying on that unstated invariant.
fn closest_point_on_triangle3(p: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let ab = super::sub_f64(b, a);
    let ac = super::sub_f64(c, a);
    let n = super::cross3(ab, ac);
    let area2 = super::dot3(n, n);
    let scale2 = super::dot3(ab, ab).max(super::dot3(ac, ac)).max(1.0);
    if area2 <= 1e-24 * scale2 * scale2 {
        let cands = [
            closest_point_on_segment3(p, a, b),
            closest_point_on_segment3(p, b, c),
            closest_point_on_segment3(p, c, a),
        ];
        let mut best = cands[0];
        for cand in cands.iter().skip(1) {
            if dist2(p, *cand) < dist2(p, best) {
                best = *cand;
            }
        }
        return best;
    }

    let ap = super::sub_f64(p, a);
    let d1 = super::dot3(ab, ap);
    let d2 = super::dot3(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = super::sub_f64(p, b);
    let d3 = super::dot3(ab, bp);
    let d4 = super::dot3(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
    }
    let cp = super::sub_f64(p, c);
    let d5 = super::dot3(ab, cp);
    let d6 = super::dot3(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [
            b[0] + w * (c[0] - b[0]),
            b[1] + w * (c[1] - b[1]),
            b[2] + w * (c[2] - b[2]),
        ];
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    [
        a[0] + v * ab[0] + w * ac[0],
        a[1] + v * ab[1] + w * ac[1],
        a[2] + v * ab[2] + w * ac[2],
    ]
}

/// Minimum distance from `p` to any triangle of `mesh`. The operands here are
/// a handful of `boxed()` triangles, so a linear scan is adequate and avoids
/// the production BVH's own pruning.
fn min_point_to_mesh_distance(p: [f64; 3], mesh: &[Tri]) -> f64 {
    mesh.iter()
        .map(|t| dist2(p, closest_point_on_triangle3(p, t[0], t[1], t[2])))
        .fold(f64::INFINITY, f64::min)
        .sqrt()
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

    // Centroid-to-opposite-surface proximity. MEASUREMENT ONLY — no assertion,
    // because no threshold is known yet and pinning an unverified one is how a
    // diagnostic turns into a false signal.
    //
    // CORRECTION (measured, see this file's "Which regime decides" section):
    // this block used to claim that "no face pair is within 28 degrees of
    // parallel, so the coincident-face regime never fires and every triangle is
    // classified by the ray cast". That is FALSE, and it is false about the one
    // triangle that matters. `kept[16] = [17, 13, 14]` IS classified by regime 1
    // — coincidence is established from the CENTROID, which needs no face pair
    // to be parallel at all. Leaving the claim in place would send the next
    // reader looking at the ray cast for a defect that is not there.
    //
    // What the distances below still say: whether a centroid sits close enough
    // to the other operand's surface for the f64 rounding in `centroid` to
    // matter. `kept[16]`'s 1.86e-5 is the one that does.
    //
    // NOTE: `cargo test --workspace` CAPTURES stdout for a passing test, and
    // this test passes while the defect exists, so CI will not show these
    // lines. Run it directly:
    //   cargo test -p ifc-lite-geometry --lib issue_3353_vid_census -- --nocapture
    // Once the values are known they can be pinned as an assertion, which
    // would then surface in CI on any change.
    let implicated: BTreeSet<usize> = overused
        .iter()
        .flat_map(|(_, users)| users.iter().map(|(idx, _)| *idx))
        .collect();
    println!(
        "centroid-to-opposite-surface distance, {} kept triangle(s) on an over-used edge:",
        implicated.len()
    );
    for idx in implicated {
        let tri = kept[idx];
        let origin = origin_of(tri, &tris_a, &tris_b);
        let c = super::centroid(&arr, tri);
        let mag = super::dot3(c, c).sqrt();
        let report = |label: &str, surface: &[Tri]| {
            let d = min_point_to_mesh_distance(c, surface);
            let relative = if mag > 0.0 { d / mag } else { f64::NAN };
            println!(
                "  kept[{idx}] {tri:?} origin={origin:?} dist_to_{label}={d:.6e} \
                 relative={relative:.3e} |centroid|={mag:.6e}"
            );
        };
        match origin {
            Origin::A => report("b", &b),
            Origin::B => report("a", &a),
            // Attribution is undecidable for a triangle present on both sides
            // (see `Origin::Both`), so report against both rather than guess.
            Origin::Both => {
                report("a", &a);
                report("b", &b);
            }
            Origin::Unresolved => unreachable!("ruled out by the guard above"),
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
