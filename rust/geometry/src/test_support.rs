// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test-harness helpers shared by the termination/deadlock suites.
//!
//! Compiled only under `cfg(test)` or the `test-support` feature, which no
//! shipping build enables (same shape as `triangulation-alt`). The feature
//! exists so `ifc-lite-processing`'s integration tests can reach
//! [`recv_or_diagnose`] too — the alternative was a seventh hand-written copy
//! of the same two-arm match.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

/// Receive one value from a watchdogged worker, or panic with the diagnosis
/// that actually fits what happened.
///
/// `recv_timeout` returns `Err` for BOTH `Timeout` and `Disconnected`, so a
/// harness that tests `is_ok()` — or collapses the two `Err` arms into one —
/// reports a worker PANIC as a hang. That is a confident wrong diagnosis: it
/// sends the reader after a termination guard that is working fine, while the
/// real panic scrolls past unread (#2945).
///
/// The two states therefore get two messages, chosen by the caller:
/// - `Timeout` — nothing arrived and the sender is still alive: a real hang.
///   Panics with `hung_msg`.
/// - `Disconnected` — the sender was dropped without sending, which for these
///   suites means the worker unwound. Panics with `panicked_msg`.
///
/// The match is exhaustive by variant with no wildcard arm, so a future third
/// `RecvTimeoutError` state fails to compile here rather than being silently
/// folded into one of the existing diagnoses.
///
/// Note the honest limit of `Disconnected`: it says the sender is gone, not
/// why. A worker that returns early without sending is reported as a panic.
/// Every caller here sends on its last line, so the two coincide.
#[track_caller]
pub fn recv_or_diagnose<T>(
    rx: &Receiver<T>,
    timeout: Duration,
    hung_msg: &str,
    panicked_msg: &str,
) -> T {
    match rx.recv_timeout(timeout) {
        Ok(value) => value,
        Err(RecvTimeoutError::Timeout) => panic!("{hung_msg}"),
        Err(RecvTimeoutError::Disconnected) => panic!("{panicked_msg}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUNG: &str = "WORKER HUNG (walk did not terminate)";
    const PANICKED: &str = "WORKER PANICKED (not a hang)";

    /// A genuine hang must never be diagnosed as a hang for only ~0.2s of
    /// wall clock, so the meta-tests use a deliberately tiny timeout. The
    /// production call sites use 5-180s; the helper's behaviour does not
    /// depend on the magnitude.
    const SHORT: Duration = Duration::from_millis(200);

    /// Run `f`, returning the panic message it produced (panic output
    /// suppressed so a passing meta-test does not print a scary backtrace).
    fn panic_message(f: impl FnOnce() + std::panic::UnwindSafe) -> String {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let payload = std::panic::catch_unwind(f);
        std::panic::set_hook(prev);
        let payload = payload.expect_err("the helper was expected to panic");
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .expect("panic payload should be a string")
    }

    /// Direction 1 — a worker that PANICS must be diagnosed as a panic.
    ///
    /// This is the #2945 defect itself: the worker's `tx` is dropped by the
    /// unwind, `recv_timeout` returns `Disconnected`, and a harness that does
    /// not split the two `Err` variants blames a hang.
    #[test]
    fn a_panicking_worker_is_diagnosed_as_a_panic_not_a_hang() {
        let (tx, rx) = std::sync::mpsc::channel::<u32>();
        let worker = std::thread::spawn(move || {
            let _tx = tx;
            std::panic::panic_any("worker exploded");
        });

        // A long timeout: if this were reported as a hang it could only be
        // because the variants were conflated, not because time ran out.
        let msg = panic_message(|| {
            recv_or_diagnose(&rx, Duration::from_secs(30), HUNG, PANICKED);
        });

        assert_eq!(msg, PANICKED, "a dropped sender must read as a worker panic");
        assert_ne!(msg, HUNG, "a panicking worker must NOT be called a hang");
        let _ = worker.join();
    }

    /// Direction 2 — a worker that genuinely HANGS must be diagnosed as a
    /// hang. The mirror of the test above, and the half that is usually
    /// missing: a fix that simply renamed every `Err` to "PANICKED" would
    /// pass direction 1 and be just as wrong.
    #[test]
    fn a_hanging_worker_is_diagnosed_as_a_hang_not_a_panic() {
        let (tx, rx) = std::sync::mpsc::channel::<u32>();
        // Sender kept ALIVE and never used: the channel stays connected, so
        // the only reachable `Err` is `Timeout`.
        let _keep_alive = tx;

        let msg = panic_message(|| {
            recv_or_diagnose(&rx, SHORT, HUNG, PANICKED);
        });

        assert_eq!(msg, HUNG, "a live sender that never sends must read as a hang");
        assert_ne!(msg, PANICKED, "a genuine hang must NOT be called a panic");
    }

    /// The success path returns the value and panics with neither message.
    #[test]
    fn a_worker_that_answers_returns_its_value() {
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = tx.send(7_u32);
        });
        assert_eq!(recv_or_diagnose(&rx, Duration::from_secs(30), HUNG, PANICKED), 7);
        let _ = worker.join();
    }
}
