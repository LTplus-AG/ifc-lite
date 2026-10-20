// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Owned capture of the per-host diagnostics one speculative void cut can
//! change: its CSG failures, opening summary, consumed flag and the
//! request-local rect counters. A snapshot restores exactly that state; an
//! [`AttemptGuard`] restores it on rejection or unwind, so a discarded attempt
//! leaves no failure evidence behind while earlier hosts keep theirs.

use crate::router::{GeometryRouter, HostOpeningDiagnostic};
use crate::BoolFailure;

/// The host-scoped diagnostics at one point in time.
pub(super) struct HostSnapshot {
    host: u32,
    failures: Option<Vec<BoolFailure>>,
    opening: Option<HostOpeningDiagnostic>,
    consumed: bool,
    rect: crate::rect_fast::RectFastStats,
}

impl HostSnapshot {
    pub(super) fn capture(router: &GeometryRouter, host: u32) -> Self {
        Self {
            host,
            failures: router.csg_failures.borrow().get(&host).cloned(),
            opening: router.host_opening_diagnostics.borrow().get(&host).cloned(),
            consumed: router.voids_consumed_hosts.borrow().contains(&host),
            rect: *router.rect_fast_stats.borrow(),
        }
    }

    pub(super) fn restore(self, router: &GeometryRouter) {
        let host = self.host;
        match self.failures {
            Some(previous) => router.csg_failures.borrow_mut().insert(host, previous),
            None => router.csg_failures.borrow_mut().remove(&host),
        };
        match self.opening {
            Some(previous) => router
                .host_opening_diagnostics
                .borrow_mut()
                .insert(host, previous),
            None => router.host_opening_diagnostics.borrow_mut().remove(&host),
        };
        if self.consumed {
            router.voids_consumed_hosts.borrow_mut().insert(host);
        } else {
            router.voids_consumed_hosts.borrow_mut().remove(&host);
        }
        *router.rect_fast_stats.borrow_mut() = self.rect;
    }
}

/// Restores its snapshot on drop unless the attempt was accepted.
pub(super) struct AttemptGuard<'a> {
    router: &'a GeometryRouter,
    snapshot: Option<HostSnapshot>,
}

impl<'a> AttemptGuard<'a> {
    pub(super) fn new(router: &'a GeometryRouter, host: u32) -> Self {
        Self {
            router,
            snapshot: Some(HostSnapshot::capture(router, host)),
        }
    }

    /// Keep everything the attempt recorded.
    pub(super) fn accept(mut self) {
        self.snapshot = None;
    }
}

impl Drop for AttemptGuard<'_> {
    fn drop(&mut self) {
        if let Some(snapshot) = self.snapshot.take() {
            snapshot.restore(self.router);
        }
    }
}

#[cfg(test)]
#[path = "attempt_tests.rs"]
mod tests;
