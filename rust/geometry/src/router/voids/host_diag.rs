// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The per-host diagnostics a void cut records on the router, snapshotted so a
//! rejected attempt can leave no trace (ROUTER-18).
//!
//! Two attempts need it: the wall-local-frame retry, which runs the cut twice
//! and keeps only the run whose mesh is kept, and the staged planar-plus-residual
//! route, which recurses and must roll back when the composition is refused.

use crate::router::diagnostics::HostOpeningDiagnostic;
use crate::router::GeometryRouter;
use crate::BoolFailure;

/// The per-host diagnostics one void cut records on the router. The retry
/// runs the cut twice; only the run whose mesh is KEPT may leave its record,
/// so the caller snapshots around the retry and restores the other one.
pub(super) struct HostDiagSnapshot {
    csg_failures: Option<Vec<BoolFailure>>,
    host_diag: Option<HostOpeningDiagnostic>,
    consumed: bool,
    rect_fast: crate::rect_fast::RectFastStats,
}

impl HostDiagSnapshot {
    pub(super) fn capture(router: &GeometryRouter, host: u32) -> Self {
        Self {
            csg_failures: router.csg_failures.borrow().get(&host).cloned(),
            host_diag: router.host_opening_diagnostics.borrow().get(&host).cloned(),
            consumed: router.voids_consumed_hosts.borrow().contains(&host),
            rect_fast: *router.rect_fast_stats.borrow(),
        }
    }

    pub(super) fn restore(self, router: &GeometryRouter, host: u32) {
        let mut failures = router.csg_failures.borrow_mut();
        match self.csg_failures {
            Some(v) => failures.insert(host, v),
            None => failures.remove(&host),
        };
        let mut diags = router.host_opening_diagnostics.borrow_mut();
        match self.host_diag {
            Some(d) => diags.insert(host, d),
            None => diags.remove(&host),
        };
        let mut consumed = router.voids_consumed_hosts.borrow_mut();
        if self.consumed {
            consumed.insert(host);
        } else {
            consumed.remove(&host);
        }
        *router.rect_fast_stats.borrow_mut() = self.rect_fast;
    }
}

impl HostDiagSnapshot {
    /// Roll `host` back to this snapshot when the guard drops (also on unwind),
    /// unless [`HostDiagGuard::accept`] ran first. Only this host and the
    /// request-local rect counters can change during a recursion, so earlier
    /// hosts' diagnostics are preserved.
    pub(super) fn guard(self, router: &GeometryRouter, host: u32) -> HostDiagGuard<'_> {
        HostDiagGuard { router, host, snapshot: Some(self) }
    }
}

/// A [`HostDiagSnapshot`] that restores itself unless the attempt is accepted.
pub(super) struct HostDiagGuard<'a> {
    router: &'a GeometryRouter,
    host: u32,
    snapshot: Option<HostDiagSnapshot>,
}

impl HostDiagGuard<'_> {
    /// Keep what the attempt recorded.
    pub(super) fn accept(mut self) {
        self.snapshot = None;
    }
}

impl Drop for HostDiagGuard<'_> {
    fn drop(&mut self) {
        if let Some(snapshot) = self.snapshot.take() {
            snapshot.restore(self.router, self.host);
        }
    }
}
