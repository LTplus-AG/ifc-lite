// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mutation generation for the process-global output policy (PR #9614 review
//! 2, R2-1).
//!
//! Comparing policy VALUES before and after a pass cannot see a change that is
//! undone before the pass ends (A -> B -> A): products meshed under B, and the
//! result would be stored under A's key. Every policy setter instead runs
//! through [`mutate`], which advances this counter to odd before its store and
//! to even after it, seqlock style. A reader that sees the same even value
//! before and after a window knows no setter ran during it, however many
//! times a value flipped.
//!
//! Ordering: a setter's first increment is sequenced before its `Release`
//! store; a pipeline thread that observes the new value through an `Acquire`
//! load synchronizes with that store, and the caller joins the pipeline's
//! threads before it reads the counter again, so the increment is visible to
//! that read. Environment knobs are read once per process (`OnceLock`), so
//! they cannot change inside a window at all.

use std::sync::atomic::{AtomicU64, Ordering};

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Run one policy store between the two generation bumps.
pub(crate) fn mutate<T>(store: impl FnOnce() -> T) -> T {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let out = store();
    GENERATION.fetch_add(1, Ordering::SeqCst);
    out
}

/// The current mutation generation. Odd while a setter is mid-store.
pub fn policy_generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// A coherent policy: read between two equal, even generations. `None` when
/// setters kept racing the read (eight attempts); the caller must not cache.
pub fn coherent_output_policy() -> Option<(u64, super::OutputPolicy)> {
    for _ in 0..8 {
        let before = policy_generation();
        if before % 2 == 1 {
            std::hint::spin_loop();
            continue;
        }
        let policy = super::effective_output_policy();
        if policy_generation() == before {
            return Some((before, policy));
        }
    }
    None
}
