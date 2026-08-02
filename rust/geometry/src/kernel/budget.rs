// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic per-boolean exact-predicate budget (issue #1109).
//!
//! Every predicate over an implicit (intersection) point runs a cascade:
//! `interval filter → fixed-width exact → BigRational` (`predicates.rs`). The
//! interval filter resolves generic geometry for free, but on genuinely
//! near-coplanar / grazing operands its sign straddles zero, so the predicate
//! falls through to the exact tiers — the fixed-width rungs climb to ~1340 bits
//! and a few spill into BigRational (~5000× the interval tier). Boolean-heavy
//! CAD models (Tekla half-space end-clips, Revit flush openings) are full of
//! such faces, so a single hard element runs the exact path on a huge fraction
//! of the O(intersection-pairs) predicate set. The pure-Rust exact kernel has no
//! operand cap (the old BSP polygon cap was deleted in #1024), so those elements
//! grind to completion regardless of cost and stall the geometry stream at 95%
//! (issue #1109).
//!
//! This is a **deterministic** guardrail: it counts **interval-filter failures**
//! (every predicate that needed the expensive exact tier) per boolean and trips
//! when the count crosses a cap. The count is a pure function of the (snap-grid,
//! integer) operands, so the trip point is IDENTICAL on native x86_64 / aarch64
//! and on wasm32 — the server and the browser client degrade the SAME hard
//! element to the SAME fallback. That preserves the cross-target parity the
//! pure-Rust kernel exists to guarantee.
//!
//! A wall-clock budget would NOT preserve parity: the fast native server would
//! finish the exact cut while the slower wasm client tripped the timer, yielding
//! different geometry for the same model. The exact-evaluation COUNT is the right
//! metric precisely because it is platform-independent.
//!
//! On trip the boolean bails; [`crate::csg`] records `OperandTooLarge` and
//! returns the host un-cut, which routes void subtraction to the deterministic
//! #635 AABB box-cut fallback ("a square hole is dramatically less wrong than a
//! missing void").

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

/// Serialises every test that mutates the process-global `CAP` / `ELEMENT_CAP`
/// atomics, so cargo's parallel runner can't race them. Shared crate-wide (not
/// just this module's tests) so cap-mutating tests in OTHER modules — e.g. the
/// voids-router engulf-suppression regression — take the SAME lock and never
/// clobber each other's cap while a boolean runs. Test-only.
#[cfg(test)]
pub(crate) static GLOBAL_CAP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Default per-boolean exact-evaluation cap for the interactive profile.
///
/// Calibrated against the model corpus: the worst healthy boolean (a dense steel
/// element) needs ~15k exact evaluations; almost all are well under 5k. This cap
/// is **33× that worst case**, so it never false-trips a legitimate cut (a false
/// trip degrades a real cut to an AABB box — wrong geometry — which is worse than
/// finishing slowly). It only engages on the pathological near-coplanar pattern
/// of #1109 (Tekla half-space clips / Revit flush cuts), where the exact-tier
/// count runs orders of magnitude higher and would otherwise never finish. The
/// coplanar fast path (the companion perf fix) keeps hard-but-sound models well
/// under this cap; this is the safety net that turns the indefinite 95% hang
/// into a finite load. `set_cap` (or `IFC_LITE_CSG_BUDGET`) tunes it;
/// `set_cap(None)` lifts it entirely for the server/offline-export profile,
/// where "exact but slow" is acceptable.
pub const DEFAULT_CAP: u64 = 500_000;

/// Default per-ELEMENT exact-evaluation cap (#1109 follow-up).
///
/// The per-boolean cap above bounds a SINGLE boolean, but it left two holes that
/// kept boolean-heavy models stalling at 95% even after the per-boolean budget
/// shipped:
///   1. **Distributed cost.** An element with many openings (a 24-opening slab,
///      a window-dense facade) runs one boolean PER opening, each well under the
///      per-boolean cap, so none trips — yet the element's TOTAL exact work is
///      huge and the geometry batch blows the stream watchdog.
///   2. **Overshoot.** A single heavily-fragmented host face retriangulates all
///      its constraint points in ONE `triangulate` call between two per-triangle
///      `tripped()` checks, so one boolean ran to ~1.7M escalations (3.3× a 500k
///      cap) before bailing — seconds of work past the cap.
///
/// This cap counts escalations across the WHOLE element (every boolean it runs)
/// and trips once the element total crosses it, so a hard element degrades as a
/// UNIT (its remaining cuts bail to the #635 AABB box-cut) instead of grinding.
/// It is still a deterministic COUNT, so native and wasm degrade the SAME element
/// identically (parity). Calibrated on the model corpus (the `csg_model_profile`
/// harness): healthy per-element totals are p50=0, p95≈150, p99≈13k — so this cap
/// is ~8× the 99th-percentile healthy element and never false-trips a legitimate
/// cut, while the pathological slabs that hung the stream (one needed 7.7M
/// escalations → 4 MINUTES) all sit far above it. At the measured ~50-60k
/// escalations/sec it bounds a hard element to ~2 s of exact work before its
/// remaining cuts degrade. The per-element cap only engages when [`begin_element`]
/// is called (the unified batch path); direct kernel / router / server /
/// offline-export callers that never open an element scope stay unbounded,
/// exactly as before — so the pinned kernel snapshots are unchanged.
pub const DEFAULT_ELEMENT_CAP: u64 = 100_000;

/// Global per-boolean cap. `0` ⇒ unbounded (run exact to completion). Any other
/// value is the per-boolean escalation cap. Read once per boolean into a
/// thread-local so each rayon worker counts its own operation independently and
/// deterministically.
static CAP: AtomicU64 = AtomicU64::new(DEFAULT_CAP);

/// Global per-element cap. `0` ⇒ unbounded. Snapshotted by [`begin_element`].
static ELEMENT_CAP: AtomicU64 = AtomicU64::new(DEFAULT_ELEMENT_CAP);

/// Highest single-boolean escalation count seen since the last [`reset_peak`].
/// Diagnostics / cap calibration only — never read on the hot path.
static PEAK: AtomicU64 = AtomicU64::new(0);

/// Highest single-ELEMENT escalation total seen since the last [`reset_peak`].
static ELEM_PEAK: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// Escalations counted in the current boolean operation.
    static COUNT: Cell<u64> = const { Cell::new(0) };
    /// This operation's cap snapshot (`u64::MAX` when unbounded).
    static OP_CAP: Cell<u64> = const { Cell::new(u64::MAX) };
    /// Escalations accumulated across the current ELEMENT (all its booleans).
    /// Reset only by [`begin_element`]; per-boolean [`begin`] does NOT reset it.
    static ELEM_COUNT: Cell<u64> = const { Cell::new(0) };
    /// This element's cap snapshot. `u64::MAX` (unbounded) until an element scope
    /// is opened, so non-batch callers are unaffected.
    static ELEM_CAP: Cell<u64> = const { Cell::new(u64::MAX) };
}

/// Effective cap, honouring the `IFC_LITE_CSG_BUDGET` env override (read once):
/// `0` ⇒ unbounded, any other value ⇒ that cap. Lets the server/CLI and
/// calibration runs pick a profile without code changes. `set_cap` still wins.
fn env_cap() -> Option<u64> {
    use std::sync::OnceLock;
    static ENV: OnceLock<Option<u64>> = OnceLock::new();
    *ENV.get_or_init(|| std::env::var("IFC_LITE_CSG_BUDGET").ok().and_then(|v| v.parse::<u64>().ok()))
}

/// Per-element env override (`IFC_LITE_CSG_ELEMENT_BUDGET`, read once): `0` ⇒
/// unbounded, any other value ⇒ that cap. For calibration runs.
fn env_element_cap() -> Option<u64> {
    use std::sync::OnceLock;
    static ENV: OnceLock<Option<u64>> = OnceLock::new();
    *ENV.get_or_init(|| {
        std::env::var("IFC_LITE_CSG_ELEMENT_BUDGET").ok().and_then(|v| v.parse::<u64>().ok())
    })
}

/// Set the global per-boolean escalation cap. `None` = unbounded (exact to
/// completion — the server/CLI/offline-export profile); `Some(n)` = trip after
/// `n` BigRational escalations (the interactive viewer/wasm profile). The
/// default is [`DEFAULT_CAP`], so the viewer is bounded out of the box.
pub fn set_cap(cap: Option<u64>) {
    CAP.store(cap.unwrap_or(0), Ordering::Relaxed);
}

/// Set the global per-element escalation cap (#1109 follow-up). `None` =
/// unbounded. The default is [`DEFAULT_ELEMENT_CAP`].
pub fn set_element_cap(cap: Option<u64>) {
    ELEMENT_CAP.store(cap.unwrap_or(0), Ordering::Relaxed);
}

/// The active per-boolean cap, as configured (`None` ⇒ unbounded).
pub fn cap() -> Option<u64> {
    match CAP.load(Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// The active per-element cap, as configured (`None` ⇒ unbounded).
pub fn element_cap() -> Option<u64> {
    match ELEMENT_CAP.load(Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// Begin a boolean operation: reset the per-op escalation counter and snapshot
/// the cap. Call once at every public boolean entry in [`crate::csg`].
#[inline]
pub fn begin() {
    // Fold the just-finished op's count into the global peak (calibration).
    let prev = COUNT.with(|c| c.get());
    if prev != 0 {
        PEAK.fetch_max(prev, Ordering::Relaxed);
    }
    let cap = match env_cap() {
        Some(v) => v, // env override wins (0 = unbounded)
        None => CAP.load(Ordering::Relaxed),
    };
    OP_CAP.with(|c| c.set(if cap == 0 { u64::MAX } else { cap }));
    COUNT.with(|c| c.set(0));
}

/// Begin an ELEMENT scope (#1109 follow-up): reset the per-element accumulator
/// and snapshot the per-element cap. Call once per element at the unified
/// mesh-production entry (`ifc_lite_processing::element::produce_element_meshes`),
/// BEFORE its booleans run, so every boolean the element issues accumulates into
/// one budget and a hard element degrades as a whole.
///
/// The per-element cap is unbounded whenever the per-boolean profile is unbounded
/// (`set_cap(None)` / `IFC_LITE_CSG_BUDGET=0` — the server/offline-export
/// profile), so the SAME single switch keeps the server exact. Otherwise it is
/// the configured [`ELEMENT_CAP`] (or its `IFC_LITE_CSG_ELEMENT_BUDGET` override).
#[inline]
pub fn begin_element() {
    // Fold the just-finished element's total into the per-element peak.
    let prev = ELEM_COUNT.with(|c| c.get());
    if prev != 0 {
        ELEM_PEAK.fetch_max(prev, Ordering::Relaxed);
    }
    // Per-element cap is unbounded iff the per-boolean profile is unbounded.
    let boolean_unbounded = match env_cap() {
        Some(v) => v == 0,
        None => CAP.load(Ordering::Relaxed) == 0,
    };
    let elem_cap = if boolean_unbounded {
        0 // unbounded (server / offline export)
    } else {
        match env_element_cap() {
            Some(v) => v, // override (0 = unbounded)
            None => ELEMENT_CAP.load(Ordering::Relaxed),
        }
    };
    ELEM_CAP.with(|c| c.set(if elem_cap == 0 { u64::MAX } else { elem_cap }));
    ELEM_COUNT.with(|c| c.set(0));
}

/// Highest single-boolean escalation count observed since process start (or the
/// last [`reset_peak`]). For cap calibration / diagnostics.
pub fn peak() -> u64 {
    PEAK.load(Ordering::Relaxed)
}

/// Highest single-ELEMENT escalation total observed since the last
/// [`reset_peak`]. For per-element cap calibration / diagnostics.
pub fn element_peak() -> u64 {
    // Include the in-flight element so a single-element profile run sees it.
    ELEM_PEAK.load(Ordering::Relaxed).max(ELEM_COUNT.with(|c| c.get()))
}

/// Reset the global peak escalation counters (per-boolean and per-element).
pub fn reset_peak() {
    PEAK.store(0, Ordering::Relaxed);
    ELEM_PEAK.store(0, Ordering::Relaxed);
}

/// Record one exact-tier predicate evaluation (an interval-filter failure).
/// Called from the `.or_else(|| fixed::…)` arms of [`crate::kernel::predicates`]
/// — the point where a predicate leaves the cheap interval filter for the
/// expensive fixed-width / BigRational path.
///
/// DELIBERATE EXEMPTION — the cached-λ I512/I1024 tier is NOT counted. The
/// escalations tallied here all RE-DERIVE the degree-4/7 LPI/TPI lambda inside the
/// `fixed::indirect_*` / `orient2d_2i|3i` / `cmp_lex` arms of `predicates.rs`, and
/// that lambda recompute is the dominant per-escalation cost the caps were
/// calibrated against. The hot re-triangulation / arrangement predicates that run
/// straight off lambdas ALREADY interned — `retriangulate::orient2d_v` /
/// `cmp_lex_v` (their `fixed::orient2d_from_lam` / `cmp_lex_from_lam` determinant
/// branch, retriangulate.rs:51) and `arrangement::orient2d_end` (its cached
/// interval-lambda branch, arrangement/mod.rs:107) — skip that recompute, so they
/// are intentionally left OUT of the counter. Folding them in would inflate the
/// count on cheap cached evaluations and re-calibrate the effective cap, shifting
/// which elements trip and thereby perturbing valid mesh output / determinism; the
/// counter is kept as a proxy for the recompute-heavy work only.
#[inline]
pub fn note_escalation() {
    COUNT.with(|c| c.set(c.get().saturating_add(1)));
    ELEM_COUNT.with(|c| c.set(c.get().saturating_add(1)));
}

/// Whether the current boolean OR the current element has exceeded its
/// escalation budget. Checked at loop boundaries in the arrangement AND inside
/// the per-point retriangulation loop so the bail is timely and graceful. Once
/// the per-element budget is blown, every subsequent boolean the element issues
/// trips immediately (its `COUNT` resets per [`begin`], but `ELEM_COUNT` does
/// not), so the element's remaining cuts bail to the #635 AABB fallback.
#[inline]
pub fn tripped() -> bool {
    COUNT.with(|c| c.get()) >= OP_CAP.with(|c| c.get())
        || ELEM_COUNT.with(|c| c.get()) >= ELEM_CAP.with(|c| c.get())
}

/// Escalations counted so far in the current boolean (diagnostics / cap
/// calibration).
#[inline]
pub fn count() -> u64 {
    COUNT.with(|c| c.get())
}

/// Escalations accumulated so far in the current element across all its booleans
/// (diagnostics / per-element cap calibration).
#[inline]
pub fn element_count() -> u64 {
    ELEM_COUNT.with(|c| c.get())
}

/// Snapshot / restore the accumulators so a REFERENCE computation (`subtract_many`'s
/// volume-safe oracle) can't charge or trip the caller's #1109 batch budget (codex P2).
pub(crate) fn snapshot_counters() -> (u64, u64) {
    (COUNT.with(|c| c.get()), ELEM_COUNT.with(|c| c.get()))
}
pub(crate) fn restore_counters((op, elem): (u64, u64)) {
    COUNT.with(|c| c.set(op));
    ELEM_COUNT.with(|c| c.set(elem));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap counts escalations and trips at exactly the configured count,
    /// deterministically; `begin()` resets; unbounded never trips.
    #[test]
    fn cap_counts_and_trips_deterministically() {
        let _guard = GLOBAL_CAP_LOCK.lock().unwrap();
        let restore = cap();

        set_cap(Some(5));
        begin();
        assert_eq!(count(), 0);
        assert!(!tripped(), "fresh op must not be tripped");
        for _ in 0..4 {
            note_escalation();
        }
        assert_eq!(count(), 4);
        assert!(!tripped(), "4 < cap 5 must not trip");
        note_escalation(); // the 5th reaches the cap
        assert_eq!(count(), 5);
        assert!(tripped(), "count == cap must trip");
        note_escalation(); // stays tripped past the cap
        assert!(tripped());

        // begin() resets the per-op counter + trip latch.
        begin();
        assert_eq!(count(), 0);
        assert!(!tripped());

        // Unbounded never trips, no matter how many escalations.
        set_cap(None);
        begin();
        for _ in 0..10_000 {
            note_escalation();
        }
        assert_eq!(count(), 10_000);
        assert!(!tripped(), "unbounded (cap None) must never trip");

        set_cap(restore);
    }

    /// The per-element budget (#1109 follow-up) accumulates across an element's
    /// booleans even though `begin()` resets the per-boolean counter, trips the
    /// element as a whole, and is reset by `begin_element()`. It stays unbounded
    /// for callers that never open an element scope (the kernel/router tests and
    /// the server profile), which is what keeps the pinned snapshots unchanged.
    #[test]
    fn per_element_budget_accumulates_across_booleans() {
        let _guard = GLOBAL_CAP_LOCK.lock().unwrap();
        let restore_cap = cap();
        let restore_ecap = element_cap();
        // A bounded per-boolean profile so begin_element() activates the element
        // cap (it is unbounded only when the per-boolean profile is unbounded).
        set_cap(Some(1_000_000));
        set_element_cap(Some(10));

        begin_element();
        assert_eq!(element_count(), 0);
        assert!(!tripped(), "fresh element must not be tripped");

        // Three booleans, 4 escalations each = 12 total > the element cap of 10,
        // even though no single boolean's per-op count (4) reaches it.
        for _ in 0..3 {
            begin(); // per-boolean reset — does NOT reset the element accumulator
            assert_eq!(count(), 0, "begin() resets the per-boolean counter");
            for _ in 0..4 {
                note_escalation();
            }
        }
        assert_eq!(element_count(), 12);
        assert!(tripped(), "element total 12 >= element cap 10 must trip");
        // ...and it stays tripped through the NEXT boolean even after begin()
        // zeroes the per-boolean counter — so the element's remaining cuts bail.
        begin();
        assert_eq!(count(), 0);
        assert!(tripped(), "element budget stays blown across begin()");

        // begin_element() opens a fresh scope and clears the trip.
        begin_element();
        assert_eq!(element_count(), 0);
        assert!(!tripped());

        // An unbounded per-boolean profile makes the element cap unbounded too
        // (the single server/offline-export switch), so it never trips.
        set_cap(None);
        begin_element();
        for _ in 0..100_000 {
            note_escalation();
        }
        assert_eq!(element_count(), 100_000);
        assert!(!tripped(), "unbounded per-boolean profile ⇒ unbounded element");

        set_cap(restore_cap);
        set_element_cap(restore_ecap);
    }
}
