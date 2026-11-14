// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mutation generation for the process-global output policy (PR #9614 review
//! 2, R2-1; writer serialisation from review 3, R3-2).
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
use std::sync::Mutex;

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Serialises writers (PR #9614 review 3, R3-2). With two writers each doing
/// their own increment, both "before" bumps could land first and leave the
/// counter EVEN while both stores were still pending, so a reader would
/// accept a window in which the policy changed. One writer at a time keeps
/// the protocol a true single-writer seqlock: odd exactly while a store is in
/// progress, and every completed store moves it by two.
static WRITER: Mutex<()> = Mutex::new(());

/// Returns the counter to even even if `store` unwinds, so a panicking setter
/// cannot leave every later reader refusing to cache.
struct Close;

impl Drop for Close {
    fn drop(&mut self) {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// Run one policy store between the two generation bumps, holding the writer
/// lock across both.
pub(crate) fn mutate<T>(store: impl FnOnce() -> T) -> T {
    let _writer = WRITER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let _close = Close;
    store()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::{Duration, Instant};

    /// R3-2, the reviewer's schedule: writer A is inside its store when writer
    /// B starts. At 32d3c1a3 B's first bump landed beside A's, the counter read
    /// even (2) with both stores pending, and a reader accepted that window.
    /// Now B waits for A, the counter stays odd while A is inside, and no
    /// coherent policy can be read until A finishes. The stores here are
    /// no-ops, so no other test sees a changed policy.
    #[test]
    fn overlapping_writers_never_expose_an_even_generation_mid_store() {
        let start = policy_generation();
        let inside = Arc::new(Barrier::new(2));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let a = {
            let inside = inside.clone();
            std::thread::spawn(move || {
                mutate(|| {
                    inside.wait();
                    release_rx.recv().unwrap();
                })
            })
        };
        inside.wait();
        // Writer B also stays inside its store once it gets there. Before the
        // fix it got there at once, beside A, and the two first bumps left the
        // counter even with both stores pending. Now it waits for A's lock.
        let (b_started_tx, b_started_rx) = mpsc::channel::<()>();
        let (b_release_tx, b_release_rx) = mpsc::channel::<()>();
        let b = std::thread::spawn(move || {
            b_started_tx.send(()).unwrap();
            mutate(|| {
                b_release_rx.recv().unwrap();
            });
        });
        b_started_rx.recv().unwrap();
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            assert_eq!(policy_generation() % 2, 1, "generation went even while a writer was mid-store");
            std::thread::yield_now();
        }
        assert!(coherent_output_policy().is_none(), "a coherent policy was read during a store");
        release_tx.send(()).unwrap();
        a.join().unwrap();
        b_release_tx.send(()).unwrap();
        b.join().unwrap();
        assert!(policy_generation() >= start + 4, "each completed store moves the generation by two");
    }

    /// Without the unwind guard a panicking store would leave the counter odd
    /// for good, and no later reader could ever read a coherent policy.
    #[test]
    fn a_panicking_store_still_closes_the_generation() {
        let _ = std::panic::catch_unwind(|| mutate(|| panic!("setter failed")));
        let deadline = Instant::now() + Duration::from_secs(5);
        while coherent_output_policy().is_none() {
            assert!(Instant::now() < deadline, "generation stuck odd after a panicking store");
            std::thread::yield_now();
        }
    }
}
