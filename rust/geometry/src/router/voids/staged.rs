// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Atomic mixed planar/residual routing, including its diagnostics (#4617).

use super::{bool2d_path::Bool2dCut, prism_cut, topology_defect_count, GeometryRouter};
use super::{MIXED_ROUTE_DEFECT_FLOOR, MIXED_ROUTE_DEFECT_GROWTH};
use crate::router::HostOpeningDiagnostic;
use crate::{BoolFailure, Mesh};

impl GeometryRouter {
    pub(super) fn try_staged_bool2d(
        &self,
        mesh: &Mesh,
        cut: &Bool2dCut,
        element_id: u32,
    ) -> Option<Mesh> {
        let Some(residual) = self.bool2d_residual(cut) else {
            return self.try_bool2d_cut(mesh, cut).map(|(mesh, _)| mesh);
        };
        let telemetry = crate::telemetry_transaction::Transaction::new();
        let (holed, corrections) = self.try_bool2d_cut(mesh, cut)?;
        // A mandatory correction cannot run in disabled-prism mode. Do not
        // spend an exact residual cut on a result we already must discard.
        if !corrections.is_empty() && !prism_cut::enabled() {
            return None;
        }
        let mut diagnostic = HostAttempt::new(self, element_id);
        let candidate = self.apply_void_context(holed, residual, element_id);
        let candidate = prism_cut::correct_planar_overlap(&candidate, &corrections)?;
        let limit = topology_defect_count(mesh)
            .saturating_mul(MIXED_ROUTE_DEFECT_GROWTH)
            .max(MIXED_ROUTE_DEFECT_FLOOR);
        if topology_defect_count(&candidate) > limit {
            return None;
        }
        diagnostic.accepted = true;
        telemetry.commit();
        Some(candidate)
    }
}

/// Only this host and request-local rect counters can change during recursion.
/// Restore on rejection (or unwind), preserving diagnostics from earlier hosts.
struct HostAttempt<'a> {
    router: &'a GeometryRouter,
    id: u32,
    failure: Option<Vec<BoolFailure>>,
    opening: Option<HostOpeningDiagnostic>,
    consumed: bool,
    rect: crate::rect_fast::RectFastStats,
    accepted: bool,
}

impl<'a> HostAttempt<'a> {
    fn new(router: &'a GeometryRouter, id: u32) -> Self {
        Self {
            router,
            id,
            failure: router.csg_failures.borrow().get(&id).cloned(),
            opening: router.host_opening_diagnostics.borrow().get(&id).cloned(),
            consumed: router.host_consumed_by_void(id),
            rect: *router.rect_fast_stats.borrow(),
            accepted: false,
        }
    }
}

impl Drop for HostAttempt<'_> {
    fn drop(&mut self) {
        if self.accepted {
            return;
        }
        let mut failures = self.router.csg_failures.borrow_mut();
        if let Some(previous) = self.failure.take() {
            failures.insert(self.id, previous);
        } else {
            failures.remove(&self.id);
        }
        let mut openings = self.router.host_opening_diagnostics.borrow_mut();
        if let Some(previous) = self.opening.take() {
            openings.insert(self.id, previous);
        } else {
            openings.remove(&self.id);
        }
        if !self.consumed {
            self.router
                .voids_consumed_hosts
                .borrow_mut()
                .remove(&self.id);
        }
        *self.router.rect_fast_stats.borrow_mut() = self.rect;
    }
}
