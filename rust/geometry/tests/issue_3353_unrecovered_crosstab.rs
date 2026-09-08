// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353 (classification half), DIAGNOSTIC — not a fix, and not a
//! gate. Answers one question: is `Arrangement::unrecovered == 0` true of
//! EVERY torn pair in a seeded sweep of rotated/overlapping box pairs, or
//! only of the one case anyone has drilled into so far
//! (`issue_3353_sweep_261_classification_tear.rs`'s module doc records
//! `unrecovered == 0` for `sweep_261` specifically)?
//!
//! - If EVERY torn pair has `unrecovered == 0`, arrangement non-conformity
//!   is excluded as a contributing cause, and the remaining #3353
//!   classification-level work belongs entirely in `classify.rs`'s
//!   coincident-face detector disagreement (`c_on_or_near_a` vs
//!   `BComponents::surface_normal`) — four prior fix attempts there have
//!   each regressed other tests (position weld: 53 regressions; a finer
//!   guard grid: 13 regressions, reopening #1007; wholesale detector
//!   unification, tried twice: 27 regressed/3 improved; a narrowed
//!   coplanar-flag gate: broke two `clash_intersection_oracle` tests) —
//!   this rules OUT one candidate explanation for why, it does not fix it.
//! - If SOME torn pairs have `unrecovered > 0`, that is a previously
//!   unmeasured sub-population — arrangement-conformity-related tears —
//!   that needs separating from classify.rs-only tears before another fix
//!   attempt.
//!
//! ## No shared sweep-generator harness exists to reuse
//!
//! This file's sibling `issue_3353_*` tests
//! (`issue_3353_boolean_tear.rs`, `issue_3353_sweep_261_classification_tear.rs`,
//! and `fix-3353-boolean-tearing`'s now-superseded
//! `issue_3353_rotated_overlap_tearing.rs`) each document that their pinned
//! case(s) came from a randomized sweep (40000-60000 pairs), but in every
//! one of them the sweep itself was run OUT OF REPO and never committed —
//! each file commits only the specific case(s) it shrank/recovered to, plus
//! its own private copies of the `boxed()` box-mesh builder and the
//! `open_edges()` watertightness check. There is no committed sweep-generator
//! module anywhere in this repo (checked across every local `*3353*`
//! worktree branch, not just `main`) for this test to import instead of
//! writing its own.
//!
//! Given that, this test writes the smallest new generator that fits the
//! existing convention: a splitmix64-seeded RNG (same generator family named
//! in the sibling files' docs) driving the exact `boxed()` tessellation and
//! rotation shape `issue_3353_sweep_261_classification_tear.rs` uses (that
//! file's own doc comment says the tessellation is load-bearing: swapping in
//! the kernel's own `box_mesh` split moves every face centroid and changes
//! which pairs tear), biased toward overlap so the sweep actually exercises
//! the regime #3353 is about instead of spending most of its budget on
//! disjoint pairs. The pair count (8000) is reduced from the 40000-60000
//! pairs the sibling files' sweeps used, in the interest of keeping a
//! manually-invoked diagnostic's runtime bounded; the crosstab below reports
//! its own torn/total rate so a reader can judge whether that count found
//! enough torn pairs to answer the question with confidence, and the SEED is
//! bumped-and-rerun (see the constant below) if not.
//!
//! ## How this differs from `boolean()`'s existing behaviour
//!
//! Nothing about `boolean()` (or `ClippingProcessor::union_mesh`) changes.
//! This test uses a new observation-only companion,
//! `kernel::mesh_bridge::union_with_conformity` (which itself calls the new
//! `kernel::arrangement::boolean_with_conformity`), mirroring the
//! `(result, conforming)` shape `union_all` already returns for the N-ary
//! union — see those functions' doc comments in
//! `rust/geometry/src/kernel/{mesh_bridge.rs,arrangement/boolean.rs}`.
//! `boolean()`/`union()` still discard the signal exactly as before; the
//! companions just expose what they already compute.
//!
//! ## Two sweeps, two purposes
//!
//! This file has TWO tests, not one:
//!
//! - `torn_vs_unrecovered_crosstab` (below): the original 8000-pair
//!   diagnostic. `#[ignore]`d — slow, and prints a crosstab rather than
//!   asserting anything. Manual-only; see "How to run" below.
//! - `every_torn_pair_is_conforming_ci_sweep`: a SEPARATE, smaller
//!   (`CI_SWEEP_PAIRS`, see that constant's doc for the count and why) sweep
//!   that actually runs in normal CI (`cargo test --workspace`, no
//!   `--ignored` needed) and turns the same measurement into a falsifiable
//!   assertion: no pair in the sweep has BOTH `torn == true` and
//!   `unrecovered > 0`. It draws its own independently-seeded pairs (see
//!   `pair_at`/`seed_for_index`) rather than reusing any prefix of the
//!   ignored sweep's continuous RNG stream, so it does not depend on the
//!   ignored test and runs on its own.
//!
//! If the CI sweep ever fails, it prints the full crosstab and the
//! `(index, seed)` of every counterexample pair — regenerate one directly
//! with `pair_at(CI_SWEEP_BASE_SEED, index)`, no need to replay the loop.
//!
//! ## How to run the ignored (large) sweep manually
//!
//! ```text
//! cargo test --test issue_3353_unrecovered_crosstab -- --ignored --nocapture
//! ```
//!
//! Refs #3353

use ifc_lite_geometry::kernel::mesh_bridge::union_with_conformity;
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// Pair count for this diagnostic sweep. See the module doc for why this is
/// smaller than the 40000-60000 pairs the (uncommitted) sweeps referenced by
/// the sibling `issue_3353_*` files used.
const SWEEP_PAIRS: u64 = 8000;

/// splitmix64-seeded RNG, matching the generator family the sibling
/// `issue_3353_*` files' docs name for the sweeps that found their pinned
/// cases.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform f64 in `[lo, hi)`, from the top 53 bits (full `f64` mantissa).
    fn next_f64(&mut self, lo: f64, hi: f64) -> f64 {
        let bits = self.next_u64() >> 11;
        let unit = (bits as f64) * (1.0 / ((1u64 << 53) as f64));
        lo + unit * (hi - lo)
    }
}

/// Outward-wound axis-aligned box, optionally rigidly rotated about `about`.
/// Diagonal-split tessellation, matching
/// `issue_3353_sweep_261_classification_tear.rs`'s `boxed()` helper verbatim
/// (see that file's doc comment for why the tessellation is load-bearing) —
/// NOT the kernel's own `box_mesh` tessellation.
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

/// Watertightness, counting the two directions SEPARATELY after welding by
/// position at 0.1 mm — same convention and tolerance as
/// `issue_3353_sweep_261_classification_tear.rs`'s `open_edges()`. A
/// net-signed tally can cancel a real non-manifold seam to zero.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("union deleted both operands entirely".to_string());
    }
    let welded = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!(
                    "degenerate edge: triangle repeats welded vertex {a}"
                ));
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

/// Generate one rotated/overlapping box pair. `b` is offset from `a` by only
/// a fraction of `a`'s size (biased toward overlap) and rotated about its
/// own centre by a random angle around a random axis — the regime #3353's
/// sibling fixtures (`sweep_261`, the `a_rotated_overlapping_union_...`
/// case) are both drawn from.
fn gen_pair(rng: &mut SplitMix64) -> (Mesh, Mesh) {
    let a_min = [
        rng.next_f64(-2.0, 2.0),
        rng.next_f64(-2.0, 2.0),
        rng.next_f64(-2.0, 2.0),
    ];
    let a_size = [
        rng.next_f64(0.5, 4.0),
        rng.next_f64(0.5, 4.0),
        rng.next_f64(0.5, 4.0),
    ];
    // b's min is a's min plus a fraction of a's OWN size, so the two operands
    // overlap substantially far more often than a uniform-independent
    // placement would.
    let b_min = [
        a_min[0] + rng.next_f64(-0.6, 0.6) * a_size[0],
        a_min[1] + rng.next_f64(-0.6, 0.6) * a_size[1],
        a_min[2] + rng.next_f64(-0.6, 0.6) * a_size[2],
    ];
    let b_size = [
        rng.next_f64(0.5, 4.0),
        rng.next_f64(0.5, 4.0),
        rng.next_f64(0.5, 4.0),
    ];
    let axis = Vector3::new(
        rng.next_f64(-1.0, 1.0),
        rng.next_f64(-1.0, 1.0),
        rng.next_f64(-1.0, 1.0),
    );
    let angle = rng.next_f64(0.0, std::f64::consts::TAU);
    let about = [
        b_min[0] + b_size[0] / 2.0,
        b_min[1] + b_size[1] / 2.0,
        b_min[2] + b_size[2] / 2.0,
    ];

    let a = boxed(a_min, a_size, None);
    let b = boxed(b_min, b_size, Some((axis, angle, about)));
    (a, b)
}

/// Answers: of the pairs in the sweep that TORE (union came back
/// non-manifold), how many had `unrecovered == 0` (the arrangement was
/// fully conforming, per `sweep_261`'s finding) vs `unrecovered > 0` (an
/// unrecovered constraint — arrangement non-conformity)? Cross-tabulated
/// against not-torn pairs as a sanity check (an `unrecovered > 0` /
/// not-torn cell is expected and unremarkable: `boolean()`'s graceful
/// degrade already tolerates non-conformity that happens not to manifest as
/// a visible tear).
///
/// `#[ignore]`d: this is slow (up to `SWEEP_PAIRS` real boolean unions) and
/// diagnostic, not a pass/fail gate — see the module doc for what the
/// printed table means. Run with:
/// `cargo test --test issue_3353_unrecovered_crosstab -- --ignored --nocapture`
#[test]
#[ignore = "diagnostic sweep for issue #3353 (classification half); prints a \
            torn x unrecovered crosstab, not a pass/fail gate — see module doc"]
fn torn_vs_unrecovered_crosstab() {
    let clipper = ClippingProcessor::new();
    let mut rng = SplitMix64(0xC0FF_EE15_3353_5EED);

    let mut torn_unrecovered_zero = 0u64;
    let mut torn_unrecovered_pos = 0u64;
    let mut clean_unrecovered_zero = 0u64;
    let mut clean_unrecovered_pos = 0u64;
    let mut skipped_errors = 0u64;

    for _ in 0..SWEEP_PAIRS {
        let (a, b) = gen_pair(&mut rng);

        // The observation channel: the SAME arrangement `union()` computes
        // internally, with its `unrecovered` count surfaced instead of
        // discarded. Pure function of `(a, b)`, so this is independent of
        // (and does not perturb) the tear check below.
        let (_raw_union, conforming) = union_with_conformity(&a, &b);

        // Tear determination: the actual production entry point
        // (`ClippingProcessor::union_mesh`, same as the sibling `issue_3353_*`
        // fixtures use), checked with their shared `open_edges` convention.
        let out = match clipper.union_mesh(&a, &b) {
            Ok(m) => m,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };
        let torn = match open_edges(&out) {
            Ok(0) => false,
            Ok(_) => true,
            Err(_) => true,
        };

        match (torn, conforming) {
            (true, true) => torn_unrecovered_zero += 1,
            (true, false) => torn_unrecovered_pos += 1,
            (false, true) => clean_unrecovered_zero += 1,
            (false, false) => clean_unrecovered_pos += 1,
        }
    }

    let total_torn = torn_unrecovered_zero + torn_unrecovered_pos;
    println!("issue #3353 classification-half diagnostic: torn x unrecovered crosstab");
    println!("sweep pairs requested: {SWEEP_PAIRS}, skipped (union errored): {skipped_errors}");
    println!("                    unrecovered==0      unrecovered>0");
    println!(
        "torn                {:>14}      {:>14}",
        torn_unrecovered_zero, torn_unrecovered_pos
    );
    println!(
        "not torn            {:>14}      {:>14}",
        clean_unrecovered_zero, clean_unrecovered_pos
    );
    println!(
        "total torn: {total_torn} / {} ({:.3}%)",
        SWEEP_PAIRS - skipped_errors,
        100.0 * total_torn as f64 / (SWEEP_PAIRS - skipped_errors).max(1) as f64
    );
    if total_torn == 0 {
        println!(
            "no torn pairs found in this sweep — increase SWEEP_PAIRS or change the seed \
             before drawing any conclusion from this run"
        );
    } else if torn_unrecovered_pos == 0 {
        println!(
            "every torn pair had unrecovered == 0: consistent with sweep_261's single \
             traced case, extends it to the whole sweep. Arrangement non-conformity is \
             excluded as a contributing cause; the classify.rs coincident-face detector \
             disagreement is the sole remaining suspect for classification-level tears."
        );
    } else {
        println!(
            "{torn_unrecovered_pos} torn pair(s) had unrecovered > 0: a previously \
             unmeasured sub-population (arrangement-conformity-related tears) exists \
             alongside classify.rs-only tears and should be separated out before the \
             next classify.rs fix attempt."
        );
    }
}

/// Base seed for the CI sweep below. Deliberately a DIFFERENT constant from
/// the ignored sweep's `SplitMix64(0xC0FF_EE15_3353_5EED)` starting state, so
/// the two sweeps' draws do not overlap or shadow one another.
const CI_SWEEP_BASE_SEED: u64 = 0xCAFE_3353_5EED_C1C1;

/// Pair count for the CI-visible sweep (runs on every `cargo test
/// --workspace`, unlike `SWEEP_PAIRS` above which only runs under
/// `--ignored`). Chosen at 1/20 of the ignored sweep's 8000 pairs: that
/// sweep's own module doc already reduced FROM the sibling `issue_3353_*`
/// files' out-of-repo 40000-60000-pair sweeps by a comparable ~5-7x factor
/// when moving from "no committed harness" to "committed, manually-invoked
/// diagnostic"; this constant applies a similar order-of-magnitude step down
/// again when moving from "manually-invoked, run once" to "every `cargo test
/// --workspace` invocation, on every push and every PR, indefinitely" — the
/// cost that matters for a permanent CI gate is cumulative across many runs,
/// not the wall-clock of any one run. No local timing measurement backs this
/// number (disk constraints on the machine that wrote this test forbade
/// running `cargo test` locally at all); if CI shows this sweep is
/// meaningfully slower or faster than the rest of the `Rust tests` job's
/// ~28-minute budget, this constant is the number to revisit, not the
/// assertion below.
const CI_SWEEP_PAIRS: u64 = 400;

/// Deterministic seed for sweep index `index`, independent of every other
/// index in the same sweep (unlike the ignored sweep's `torn_vs_unrecovered_
/// crosstab`, which advances ONE `SplitMix64` continuously across the whole
/// loop — reproducing pair `N` there means replaying pairs `0..N` first).
/// One splitmix64 step folding `index` into `base`: `next_u64` on
/// `SplitMix64`-with-golden-ratio-increment-seeded-state is exactly
/// splitmix64's own recommended seed-mixing step, so `index` values that
/// differ only in their low bits still land on well-separated seeds.
fn seed_for_index(base: u64, index: u64) -> u64 {
    let mut mixer = SplitMix64(base ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    mixer.next_u64()
}

/// Regenerate the exact pair the CI sweep drew for `index`, from `base` and
/// `index` alone. A failing counterexample is reported as `(index, seed)`;
/// either `pair_at(CI_SWEEP_BASE_SEED, index)` or
/// `gen_pair(&mut SplitMix64(seed))` (the `seed` printed IS
/// `seed_for_index(base, index)`) reproduces it standalone, with no need to
/// replay the loop up to `index`.
fn pair_at(base: u64, index: u64) -> (Mesh, Mesh) {
    let mut rng = SplitMix64(seed_for_index(base, index));
    gen_pair(&mut rng)
}

/// CI-visible counterpart to `torn_vs_unrecovered_crosstab`, above: same
/// generator shape and tear/conformity check, run over a much smaller,
/// independently-seeded sweep (`CI_SWEEP_PAIRS`; see that constant's doc for
/// the count and why), asserting rather than merely printing.
///
/// Hypothesis under test (from `issue_3353_sweep_261_classification_tear.rs`'s
/// single drilled case, where `unrecovered == 0` held for a tear): torn
/// implies conforming, i.e. no pair in the sweep is BOTH torn AND has
/// `unrecovered > 0`. If this ever fails, arrangement non-conformity DOES
/// contribute to some #3353 tears — a previously unmeasured sub-population —
/// and the counterexamples printed below are the pairs to separate out
/// before the next `classify.rs` fix attempt. This assertion is NOT to be
/// weakened to force a pass; a failure here is a valid, actionable result.
#[test]
fn every_torn_pair_is_conforming_ci_sweep() {
    let clipper = ClippingProcessor::new();

    let mut torn_unrecovered_zero = 0u64;
    let mut torn_unrecovered_pos = 0u64;
    let mut clean_unrecovered_zero = 0u64;
    let mut clean_unrecovered_pos = 0u64;
    let mut skipped_errors = 0u64;
    let mut counterexamples: Vec<(u64, u64)> = Vec::new(); // (index, seed)

    for i in 0..CI_SWEEP_PAIRS {
        let (a, b) = pair_at(CI_SWEEP_BASE_SEED, i);

        // Same observation channel as the ignored sweep: a pure function of
        // `(a, b)`, independent of (and not perturbing) the tear check below.
        let (_raw_union, conforming) = union_with_conformity(&a, &b);

        let out = match clipper.union_mesh(&a, &b) {
            Ok(m) => m,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };
        let torn = match open_edges(&out) {
            Ok(0) => false,
            Ok(_) => true,
            Err(_) => true,
        };

        match (torn, conforming) {
            (true, true) => torn_unrecovered_zero += 1,
            (true, false) => {
                torn_unrecovered_pos += 1;
                counterexamples.push((i, seed_for_index(CI_SWEEP_BASE_SEED, i)));
            }
            (false, true) => clean_unrecovered_zero += 1,
            (false, false) => clean_unrecovered_pos += 1,
        }
    }

    let total_torn = torn_unrecovered_zero + torn_unrecovered_pos;
    let table = format!(
        "issue #3353 classification-half CI sweep: torn x unrecovered crosstab\n\
         sweep pairs requested: {CI_SWEEP_PAIRS}, skipped (union errored): {skipped_errors}\n\
         \x20                   unrecovered==0      unrecovered>0\n\
         torn                {torn_unrecovered_zero:>14}      {torn_unrecovered_pos:>14}\n\
         not torn            {clean_unrecovered_zero:>14}      {clean_unrecovered_pos:>14}\n\
         total torn: {total_torn} / {} ({:.3}%)",
        CI_SWEEP_PAIRS - skipped_errors,
        100.0 * total_torn as f64 / (CI_SWEEP_PAIRS - skipped_errors).max(1) as f64
    );
    println!("{table}");

    let completed = CI_SWEEP_PAIRS - skipped_errors;
    // `union_mesh` erroring is not "no signal" — it is the union failing to
    // produce a result at all, and the sibling `issue_3353_boolean_tear.rs`
    // sweep already treats that as a hard failure (`.expect("union must not
    // error")`) rather than something to shrug off. Left unasserted, a
    // regression that made `union_mesh` error on every pair would `continue`
    // before ever reaching the `(torn, conforming)` match, so
    // `counterexamples` would stay empty BY CONSTRUCTION and the assertion
    // below would report a false green over zero actual coverage — exactly
    // the "absent check renders as a pass" failure mode this CI gate exists
    // to avoid. So: any skip is itself the failure, reported with how many of
    // `CI_SWEEP_PAIRS` this run actually completed so a future failure here
    // is diagnosable without re-deriving `completed` by hand.
    assert_eq!(
        skipped_errors, 0,
        "{table}\n\n{skipped_errors} of {CI_SWEEP_PAIRS} pairs made `union_mesh` return Err \
         and were skipped — only {completed} pair(s) actually ran the torn/conforming check \
         below, so its pass is not meaningful coverage. `union_mesh` erroring on a generated \
         pair is itself a regression worth investigating, not a case to silently drop; do NOT \
         weaken this assertion to force a pass.",
    );

    assert!(
        counterexamples.is_empty(),
        "{table}\n\n{} of {total_torn} torn pair(s) had unrecovered > 0 (of {completed} \
         completed pairs out of {CI_SWEEP_PAIRS} requested) — arrangement non-conformity \
         contributed to a tear in this sweep, contradicting the hypothesis that every torn \
         pair in this regime is conforming. This is a real, previously unmeasured \
         sub-population, not a flake: do NOT weaken this assertion to force a pass. \
         Counterexample (index, seed) pairs — regenerate each with \
         `pair_at(CI_SWEEP_BASE_SEED, index)`:\n{counterexamples:#?}",
        counterexamples.len(),
    );
}
