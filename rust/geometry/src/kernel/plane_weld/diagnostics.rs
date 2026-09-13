// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::sync::atomic::{AtomicU64, Ordering};

// Two tallies, because a single one cannot be read: the low-level weld has
// run on every `subtract` since #1007, so subtract's long-standing traffic
// would stand in for evidence about the UNION caller that is new in #3353.
// They NEST rather than partition — a mutual promotion bumps UNION once and
// ALL once per low-level call inside it, welded vertices counted in both —
// so `ALL - UNION` is NOT subtract's share.
static CALLS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
static FIRED: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
static VERTS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

/// `CALLS[ALL]` etc.: every call to the low-level weld, whatever the caller.
pub(super) const ALL: usize = 0;
/// `CALLS[UNION]` etc.: only the union's mutual promotions.
pub(super) const UNION: usize = 1;

/// Record one promotion call into `slot`, and the vertices it moved.
#[inline]
pub(super) fn record(slot: usize, welded: usize) {
    crate::telemetry_transaction::record(move || {
        CALLS[slot].fetch_add(1, Ordering::Relaxed);
        if welded > 0 {
            FIRED[slot].fetch_add(1, Ordering::Relaxed);
        }
        VERTS[slot].fetch_add(welded as u64, Ordering::Relaxed);
    });
}

/// Read + reset `[(calls, calls that moved something, vertices moved); 2]`
/// as `[every caller, union only]`. Process-global relaxed atomics: a stale
/// read under concurrency mis-reports a diagnostic count, never geometry.
pub fn take_plane_weld_stats() -> [(u64, u64, u64); 2] {
    [ALL, UNION].map(|s| {
        (
            CALLS[s].swap(0, Ordering::Relaxed),
            FIRED[s].swap(0, Ordering::Relaxed),
            VERTS[s].swap(0, Ordering::Relaxed),
        )
    })
}
