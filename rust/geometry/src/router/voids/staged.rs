// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Atomic mixed planar/residual routing, including its diagnostics (#4617).

use super::{bool2d_path::Bool2dCut, prism_cut, topology_defect_count};
use super::{MIXED_ROUTE_DEFECT_FLOOR, MIXED_ROUTE_DEFECT_GROWTH};
use crate::program::openings::execute::Execution;
use crate::Mesh;

impl Execution {
    pub(super) fn try_staged_bool2d(
        &self,
        mesh: &Mesh,
        cut: &Bool2dCut,
        element_id: u32,
    ) -> crate::Result<Option<Mesh>> {
        crate::resource::check_current()?;
        let Some(residual) = self.bool2d_residual(cut) else {
            return self.try_bool2d_cut(mesh, cut).map(|candidate| candidate.map(|(mesh, _)| mesh));
        };
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.staged_mixed_attempts = c.staged_mixed_attempts.saturating_add(1)
        });
        let provisional = Execution::new(self.tessellation_quality, self.configuration);
        let (candidate, telemetry) = crate::telemetry_transaction::capture(|| -> crate::Result<Option<Mesh>> {
            let Some((holed, corrections)) = provisional.try_bool2d_cut(mesh, cut)? else {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    c.staged_planar_refusals = c.staged_planar_refusals.saturating_add(1)
                });
                return Ok(None);
            };
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| {
                c.staged_correction_cutters = c
                    .staged_correction_cutters
                    .saturating_add(corrections.len() as u64)
            });
            // A mandatory correction cannot run in disabled-prism mode. Do not
            // spend an exact residual cut on a result we already must discard.
            let correction_disabled = !corrections.is_empty() && !self.configuration.prism.read();
            crate::resource::check_current()?;
            if correction_disabled {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    c.staged_disabled_correction_refusals =
                        c.staged_disabled_correction_refusals.saturating_add(1)
                });
                return Ok(None);
            }
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| {
                c.staged_residual_calls = c.staged_residual_calls.saturating_add(1)
            });
            let candidate = provisional.apply_void_context(holed, residual, element_id)?;
            crate::resource::check_current()?;
            let prism_enabled = corrections.is_empty() || self.configuration.prism.read();
            crate::resource::check_current()?;
            let corrected = prism_cut::correct_planar_overlap(
                &candidate,
                &corrections,
                prism_enabled,
            )?;
            crate::resource::check_current()?;
            let Some(candidate) = corrected else {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    c.staged_correction_refusals = c.staged_correction_refusals.saturating_add(1)
                });
                return Ok(None);
            };
            crate::resource::check_current()?;
            let limit = topology_defect_count(mesh)
                .saturating_mul(MIXED_ROUTE_DEFECT_GROWTH)
                .max(MIXED_ROUTE_DEFECT_FLOOR);
            let defects = topology_defect_count(&candidate);
            crate::resource::check_current()?;
            if defects > limit {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    c.staged_topology_refusals = c.staged_topology_refusals.saturating_add(1)
                });
                return Ok(None);
            }
            crate::resource::check_current()?;
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| {
                c.staged_commits = c.staged_commits.saturating_add(1)
            });
            Ok(Some(candidate))
        });
        let Some(candidate) = candidate? else { return Ok(None); };
        crate::resource::check_current()?;
        self.accept(provisional);
        telemetry.commit();
        Ok(Some(candidate))
    }
}
