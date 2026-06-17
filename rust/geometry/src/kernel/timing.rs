// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Step 0 of the kernel-speed roadmap: per-phase wall-clock timers + per-phase
//! invocation counts + per-predicate-tier escalation counters, so we stop flying
//! blind on where a CSG boolean's time actually goes — on BOTH native and wasm.
//!
//! - **Phase timers** use `std::time::Instant` on native (server/CLI). On wasm32
//!   `Instant` is unavailable, so the wall-clock is skipped there and the
//!   **op counts + tier counters** (clock-free) carry the structural breakdown —
//!   which is exactly the data that answers "which phase dominates" and "what
//!   fraction of predicates escalate to the wasm-expensive wide-int / rational
//!   tier".
//! - Everything is behind the `kernel-timing` cargo feature and compiles to
//!   **nothing** when off (the entry points are `#[inline(always)]` no-ops over
//!   a zero-sized guard), so production native and wasm pay zero cost. Enable for
//!   a measured run: `cargo … --features kernel-timing`, or pass
//!   `--features kernel-timing` to `build-wasm.sh` for a wasm profiling bundle.

/// A phase of one CSG boolean (`mesh_bridge::subtract` → `arrange` → classify →
/// `tris_to_mesh` → `consolidate_coplanar`).
#[derive(Clone, Copy)]
pub enum Phase {
    MeshToTris = 0,
    Broadphase = 1,
    TriTri = 2,
    SplitCrossings = 3,
    Retriangulate = 4,
    Classify = 5,
    TrisToMesh = 6,
    Consolidate = 7,
}
pub const N_PHASES: usize = 8;
const PHASE_NAMES: [&str; N_PHASES] = [
    "mesh_to_tris",
    "broadphase",
    "tri_tri",
    "split_crossings",
    "retriangulate",
    "classify",
    "tris_to_mesh",
    "consolidate",
];

/// A predicate evaluation tier. `PredCall` is every exact predicate evaluation
/// (the denominator); `Escalation` is those that fell past the cheap f64
/// interval filter into the fixed-point tier (the wide-int work wasm32 emulates
/// as multi-limb); `Rational` is the `BigRational` heap tier (~3 ms/call).
#[derive(Clone, Copy)]
pub enum Tier {
    PredCall = 0,
    Escalation = 1,
    Rational = 2,
}
pub const N_TIERS: usize = 3;

#[cfg(feature = "kernel-timing")]
mod inner {
    use super::{Phase, Tier, N_PHASES, N_TIERS};
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(super) static PHASE_NS: [AtomicU64; N_PHASES] = [const { AtomicU64::new(0) }; N_PHASES];
    pub(super) static PHASE_OPS: [AtomicU64; N_PHASES] = [const { AtomicU64::new(0) }; N_PHASES];
    pub(super) static TIERS: [AtomicU64; N_TIERS] = [const { AtomicU64::new(0) }; N_TIERS];

    // Monotonic nanosecond clock. Native uses `Instant` (lazy epoch). wasm32 has
    // no `Instant`, so the host injects a millisecond clock (`performance.now`)
    // via `set_wasm_clock`; until it does, wasm wall-clock reads 0 (the op/tier
    // counts still work). Keeping the host clock OUT of the geometry crate (which
    // must stay web-free) — it's a plain `fn() -> f64` pointer set by wasm-bindings.
    #[cfg(not(target_arch = "wasm32"))]
    fn now_ns() -> u64 {
        static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        EPOCH.get_or_init(std::time::Instant::now).elapsed().as_nanos() as u64
    }

    #[cfg(target_arch = "wasm32")]
    static WASM_CLOCK: std::sync::OnceLock<fn() -> f64> = std::sync::OnceLock::new();

    #[cfg(target_arch = "wasm32")]
    pub fn set_wasm_clock(f: fn() -> f64) {
        let _ = WASM_CLOCK.set(f);
    }

    #[cfg(target_arch = "wasm32")]
    fn now_ns() -> u64 {
        WASM_CLOCK
            .get()
            .map(|f| (f() * 1.0e6) as u64)
            .unwrap_or(0)
    }

    /// RAII phase guard: bumps the phase invocation count, and on drop adds the
    /// elapsed wall-clock.
    pub struct PhaseTimer {
        phase: usize,
        start: u64,
    }

    impl Drop for PhaseTimer {
        #[inline]
        fn drop(&mut self) {
            PHASE_OPS[self.phase].fetch_add(1, Ordering::Relaxed);
            PHASE_NS[self.phase].fetch_add(now_ns().saturating_sub(self.start), Ordering::Relaxed);
        }
    }

    #[inline]
    pub fn timer(p: Phase) -> PhaseTimer {
        PhaseTimer {
            phase: p as usize,
            start: now_ns(),
        }
    }

    #[inline]
    pub fn tier(t: Tier) {
        TIERS[t as usize].fetch_add(1, Ordering::Relaxed);
    }
}

/// Inject a millisecond wall-clock for wasm phase timing (e.g. `performance.now`).
/// No-op on native (uses `Instant`) and when the feature is off.
#[cfg(all(feature = "kernel-timing", target_arch = "wasm32"))]
pub fn set_wasm_clock(f: fn() -> f64) {
    inner::set_wasm_clock(f);
}
#[cfg(not(all(feature = "kernel-timing", target_arch = "wasm32")))]
#[inline(always)]
pub fn set_wasm_clock(_f: fn() -> f64) {}

#[cfg(not(feature = "kernel-timing"))]
mod inner {
    use super::{Phase, Tier};
    /// Zero-sized no-op guard — drops to nothing.
    pub struct PhaseTimer;
    #[inline(always)]
    pub fn timer(_: Phase) -> PhaseTimer {
        PhaseTimer
    }
    #[inline(always)]
    pub fn tier(_: Tier) {}
}

pub use inner::{tier, timer, PhaseTimer};

/// A drained snapshot of the kernel timing/counters.
#[derive(Default, Clone)]
pub struct KernelTiming {
    pub phase_ns: [u64; N_PHASES],
    pub phase_ops: [u64; N_PHASES],
    pub tiers: [u64; N_TIERS],
}

/// Read AND reset the global timing/counters (call once per measured batch).
#[cfg(feature = "kernel-timing")]
pub fn take() -> KernelTiming {
    use std::sync::atomic::Ordering;
    let mut t = KernelTiming::default();
    for i in 0..N_PHASES {
        t.phase_ns[i] = inner::PHASE_NS[i].swap(0, Ordering::Relaxed);
        t.phase_ops[i] = inner::PHASE_OPS[i].swap(0, Ordering::Relaxed);
    }
    for i in 0..N_TIERS {
        t.tiers[i] = inner::TIERS[i].swap(0, Ordering::Relaxed);
    }
    t
}

#[cfg(not(feature = "kernel-timing"))]
pub fn take() -> KernelTiming {
    KernelTiming::default()
}

impl KernelTiming {
    pub fn is_empty(&self) -> bool {
        self.phase_ops.iter().all(|&x| x == 0) && self.tiers.iter().all(|&x| x == 0)
    }

    /// One-line summary: per-phase ms (and % of measured wall-clock, 0 on wasm
    /// where there is no clock) + invocation counts, then the predicate-tier
    /// escalation fractions (the wasm-cost signal).
    pub fn format(&self) -> String {
        let total_ns: u64 = self.phase_ns.iter().sum();
        let mut s = String::new();
        for i in 0..N_PHASES {
            let pct = if total_ns > 0 {
                100.0 * self.phase_ns[i] as f64 / total_ns as f64
            } else {
                0.0
            };
            s.push_str(&format!(
                "{}={:.0}ms/{:.0}%/{}ops ",
                PHASE_NAMES[i],
                self.phase_ns[i] as f64 / 1.0e6,
                pct,
                self.phase_ops[i],
            ));
        }
        let (calls, esc, rat) = (self.tiers[0], self.tiers[1], self.tiers[2]);
        let esc_pct = if calls > 0 { 100.0 * esc as f64 / calls as f64 } else { 0.0 };
        let rat_pct = if calls > 0 { 100.0 * rat as f64 / calls as f64 } else { 0.0 };
        s.push_str(&format!(
            "| predicates={calls} escalated={esc}({esc_pct:.1}%) rational={rat}({rat_pct:.3}%)"
        ));
        s
    }
}
