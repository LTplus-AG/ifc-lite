// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! In-memory marker for "a data-model write is running right now for this
//! cache key" (issue #5129).
//!
//! `get_data_model` needs to tell a client "not yet, keep polling" apart from
//! "not for this key, stop asking": the first is 202, the second 404. A cache
//! miss alone cannot make that distinction — the entry could be absent because
//! nothing ever asked for it, which is exactly the case the issue's 404 is
//! for. This set is the missing signal: a key is present in it for the
//! lifetime of the one background task that could still write it
//! (`parse_parquet_stream`'s data-model fill), and gone the moment that task
//! ends, however it ends.

use rustc_hash::FxHashSet;
use std::sync::{Arc, Mutex};

/// The set of cache keys with a data-model write in flight. One instance
/// lives on `AppState`, shared by every request.
#[derive(Default)]
pub struct InFlightKeys(Mutex<FxHashSet<String>>);

impl InFlightKeys {
    /// Mark `key` as in flight and return a guard that clears it on drop.
    ///
    /// Takes `self` as `Arc` so the returned guard can outlive the borrow —
    /// it is moved into the spawned task, which outlives the request handler
    /// that calls `begin`.
    pub fn begin(self: &Arc<Self>, key: String) -> InFlightGuard {
        if let Ok(mut keys) = self.0.lock() {
            keys.insert(key.clone());
        }
        InFlightGuard {
            keys: self.clone(),
            key,
        }
    }

    /// Whether a write for `key` is in flight right now.
    ///
    /// A lock-poisoned set (a prior holder panicked mid-mutation) answers
    /// `false`: the safe direction is a 404 telling the client to re-upload,
    /// not a 202 that polls a key nothing can ever finish writing.
    pub fn contains(&self, key: &str) -> bool {
        self.0.lock().map(|keys| keys.contains(key)).unwrap_or(false)
    }
}

/// RAII marker returned by [`InFlightKeys::begin`]. Removes its key on drop —
/// on task completion, on early return (e.g. admission saturated), and on
/// panic unwind alike, so the marker can never outlive the work it stands
/// for.
pub struct InFlightGuard {
    keys: Arc<InFlightKeys>,
    key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut keys) = self.keys.0.lock() {
            keys.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `contains` is true only between `begin` and the guard's drop.
    #[test]
    fn contains_true_only_while_guard_is_alive() {
        let keys = Arc::new(InFlightKeys::default());
        assert!(!keys.contains("k"));
        let guard = keys.begin("k".to_string());
        assert!(keys.contains("k"));
        drop(guard);
        assert!(!keys.contains("k"));
    }

    /// Two different keys don't interfere with each other.
    #[test]
    fn keys_are_independent() {
        let keys = Arc::new(InFlightKeys::default());
        let guard_a = keys.begin("a".to_string());
        assert!(keys.contains("a"));
        assert!(!keys.contains("b"));
        let guard_b = keys.begin("b".to_string());
        assert!(keys.contains("b"));
        drop(guard_a);
        assert!(!keys.contains("a"));
        assert!(keys.contains("b"));
        drop(guard_b);
        assert!(!keys.contains("b"));
    }
}
