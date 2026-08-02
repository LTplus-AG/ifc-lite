// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `api::mod` — extracted from an inline `#[cfg(test)]` block so
//! `mod.rs` stays under the module-size ratchet budget. As a child of the
//! `api` module (`#[cfg(test)] mod mod_tests;` in `mod.rs`), `super`
//! resolves to `api`, so these tests keep private-field access to `IfcAPI`.
//!
//! ## Poisoned-mutex recovery (the contract this file guards)
//!
//! Every `.lock()` on `IfcAPI`'s cache `Mutex` fields recovers via
//! `.unwrap_or_else(std::sync::PoisonError::into_inner)` instead of
//! `.expect(...)`-panicking, so one malformed file's panic no longer bricks a
//! long-lived / multi-tenant `IfcAPI` (e.g. a parser worker reused across many
//! `parse` calls) for the rest of its lifetime. This is safe for the cache
//! slots (`cached_entity_index`, `cached_item_dedup`, `cached_parts_to_skip`,
//! and friends): each is read and then replaced wholesale
//! (`*slot = <freshly built value>` / `slot.take()`), never mutated
//! field-by-field, so a panic while the lock is *held* necessarily happens
//! before that one assignment runs — the guarded value is never torn, only
//! ever the last known-good value or its untouched initial default.
//! `pipeline_diagnostics` is the one exception (`record_batch` mutates its
//! counters in place), but it is best-effort observability only (surfaced via
//! `getPipelineDiagnostics`), never read for control flow or geometry
//! correctness, so recovering there risks at most a one-batch counter
//! undercount versus permanently losing the whole diagnostics channel.

use super::IfcAPI;

/// A panic on another thread while it holds one of the cache mutexes
/// (e.g. a malformed entity deep in a lazy cache rebuild) must not
/// brick every later call on this `IfcAPI` instance. Poison
/// `cached_entity_index` directly, exactly like a real panicking
/// rebuild would, then assert `clearPrePassCache` — which locks every
/// cache mutex in turn — still returns normally instead of panicking
/// on `.expect("... Mutex poisoned")` (the pre-fix behaviour).
#[test]
fn clear_pre_pass_cache_recovers_from_a_poisoned_cache_mutex() {
    let api = IfcAPI::new();

    // Poison cached_entity_index: hold the lock on a spawned thread and
    // panic while holding it. Unwinding through the MutexGuard's Drop
    // is what marks a std::sync::Mutex poisoned.
    let join_result = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let _guard = api.cached_entity_index.lock().unwrap();
                panic!("intentional poison for the poison-recovery test");
            })
            .join()
    });
    assert!(
        join_result.is_err(),
        "the spawned thread must have panicked while holding the lock"
    );
    assert!(
        api.cached_entity_index.is_poisoned(),
        "the mutex must be poisoned after the spawned thread panicked while holding it"
    );

    // Pre-fix, this call panicked on
    // `.expect("ifc-lite cached_entity_index Mutex poisoned")`. It must
    // now recover and clear every cache slot instead.
    api.clear_pre_pass_cache();

    // Recovering via `unwrap_or_else(PoisonError::into_inner)` does not
    // clear the mutex's poison flag, so every future `.lock()` on it
    // still observes `Err(PoisonError)` — the fix is recovering from
    // that on *every* access, not a one-shot clear. Prove a second call
    // also succeeds instead of panicking again.
    api.clear_pre_pass_cache();
}
