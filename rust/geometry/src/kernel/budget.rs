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

/// Global cap. `0` ⇒ unbounded (run exact to completion). Any other value is the
/// per-boolean escalation cap. Read once per boolean into a thread-local so each
/// rayon worker counts its own operation independently and deterministically.
static CAP: AtomicU64 = AtomicU64::new(DEFAULT_CAP);

/// Highest single-boolean escalation count seen since the last [`reset_peak`].
/// Diagnostics / cap calibration only — never read on the hot path.
static PEAK: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// Escalations counted in the current boolean operation.
    static COUNT: Cell<u64> = const { Cell::new(0) };
    /// This operation's cap snapshot (`u64::MAX` when unbounded).
    static OP_CAP: Cell<u64> = const { Cell::new(u64::MAX) };
}

/// Effective cap, honouring the `IFC_LITE_CSG_BUDGET` env override (read once):
/// `0` ⇒ unbounded, any other value ⇒ that cap. Lets the server/CLI and
/// calibration runs pick a profile without code changes. `set_cap` still wins.
fn env_cap() -> Option<u64> {
    use std::sync::OnceLock;
    static ENV: OnceLock<Option<u64>> = OnceLock::new();
    *ENV.get_or_init(|| std::env::var("IFC_LITE_CSG_BUDGET").ok().and_then(|v| v.parse::<u64>().ok()))
}

/// Set the global per-boolean escalation cap. `None` = unbounded (exact to
/// completion — the server/CLI/offline-export profile); `Some(n)` = trip after
/// `n` BigRational escalations (the interactive viewer/wasm profile). The
/// default is [`DEFAULT_CAP`], so the viewer is bounded out of the box.
pub fn set_cap(cap: Option<u64>) {
    CAP.store(cap.unwrap_or(0), Ordering::Relaxed);
}

/// The active cap, as configured (`None` ⇒ unbounded).
pub fn cap() -> Option<u64> {
    match CAP.load(Ordering::Relaxed) {
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

/// Highest single-boolean escalation count observed since process start (or the
/// last [`reset_peak`]). For cap calibration / diagnostics.
pub fn peak() -> u64 {
    PEAK.load(Ordering::Relaxed)
}

/// Reset the global peak escalation counter.
pub fn reset_peak() {
    PEAK.store(0, Ordering::Relaxed);
}

/// Record one exact-tier predicate evaluation (an interval-filter failure).
/// Called from the `.or_else(|| fixed::…)` arms of [`crate::kernel::predicates`]
/// — the point where a predicate leaves the cheap interval filter for the
/// expensive fixed-width / BigRational path.
#[inline]
pub fn note_escalation() {
    COUNT.with(|c| c.set(c.get().saturating_add(1)));
}

/// Whether the current boolean has exceeded its escalation budget. Checked at
/// loop boundaries in the arrangement so the bail is timely and graceful.
#[inline]
pub fn tripped() -> bool {
    COUNT.with(|c| c.get()) >= OP_CAP.with(|c| c.get())
}

/// Escalations counted so far in the current boolean (diagnostics / cap
/// calibration).
#[inline]
pub fn count() -> u64 {
    COUNT.with(|c| c.get())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap counts escalations and trips at exactly the configured count,
    /// deterministically; `begin()` resets; unbounded never trips. (Only this
    /// test mutates the global cap, so there is no cross-test race on it.)
    #[test]
    fn cap_counts_and_trips_deterministically() {
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
}
