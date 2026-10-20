// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Atomic mixed planar/residual routing, including its diagnostics (#4617).

use super::attempt::AttemptGuard;
use super::{bool2d_path::Bool2dCut, prism_cut, topology_defect_count, GeometryRouter};
use super::{MIXED_ROUTE_DEFECT_FLOOR, MIXED_ROUTE_DEFECT_GROWTH};
use crate::Mesh;

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
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.staged_mixed_attempts = c.staged_mixed_attempts.saturating_add(1));
        let (candidate, telemetry) = crate::telemetry_transaction::capture(|| {
            let Some((holed, corrections)) = self.try_bool2d_cut(mesh, cut) else {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.staged_planar_refusals = c.staged_planar_refusals.saturating_add(1));
                return None;
            };
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.staged_correction_cutters = c.staged_correction_cutters.saturating_add(corrections.len() as u64));
            // A mandatory correction cannot run in disabled-prism mode. Do not
            // spend an exact residual cut on a result we already must discard.
            if !corrections.is_empty() && !prism_cut::enabled() {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.staged_disabled_correction_refusals = c.staged_disabled_correction_refusals.saturating_add(1));
                return None;
            }
            let attempt = AttemptGuard::new(self, element_id);
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.staged_residual_calls = c.staged_residual_calls.saturating_add(1));
            let candidate = self.apply_void_context(holed, residual, element_id);
            let Some(candidate) = prism_cut::correct_planar_overlap(&candidate, &corrections) else {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.staged_correction_refusals = c.staged_correction_refusals.saturating_add(1));
                return None;
            };
            let limit = topology_defect_count(mesh)
                .saturating_mul(MIXED_ROUTE_DEFECT_GROWTH)
                .max(MIXED_ROUTE_DEFECT_FLOOR);
            if topology_defect_count(&candidate) > limit {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.staged_topology_refusals = c.staged_topology_refusals.saturating_add(1));
                return None;
            }
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.staged_commits = c.staged_commits.saturating_add(1));
            attempt.accept();
            Some(candidate)
        });
        let candidate = candidate?;
        telemetry.commit();
        Some(candidate)
    }
}
