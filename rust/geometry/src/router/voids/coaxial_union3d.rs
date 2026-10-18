// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded candidate selection for the 3D opening-union consumer (#3925).

use super::{accept_cut, mesh_is_closed_exact, UnionCand};
use super::super::sweep::mesh_to_keep;
use crate::{ClippingProcessor, GeometryRouter, Mesh};

pub(super) fn subtract(
    result: &mut Mesh,
    cands: &[UnionCand],
    members: &[usize],
    clipper: &ClippingProcessor,
) -> crate::Result<bool> {
    crate::resource::check_current()?;
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::record(|c| c.coaxial_union_attempts = c.coaxial_union_attempts.saturating_add(1));
    let extended: Vec<Mesh> = members
        .iter()
        .map(|&m| {
            GeometryRouter::extend_opening_mesh_through_host(&cands[m].mesh, result, cands[m].dir)
        })
        .collect();
    let refs: Vec<&Mesh> = extended.iter().collect();
    // Preserve the existing accepted union: choosing an unpromoted candidate
    // first changes valid large-model cuts. Only an unusable union gets a retry.
    let union = crate::kernel::mesh_bridge::union_many(&refs);
    crate::resource::check_current()?;
    let mut union = ClippingProcessor::consolidate_coplanar(union);
    crate::resource::check_current()?;
    if union.is_empty() || !mesh_is_closed_exact(&union) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.coaxial_promoted_refusals = c.coaxial_promoted_refusals.saturating_add(1));
        // Never conceal an exhausted operation behind another candidate.
        if crate::kernel::budget::tripped() {
            return Ok(false);
        }
        let candidate = crate::kernel::mesh_bridge::union_many_preserving_coordinates(&refs);
        crate::resource::check_current()?;
        union = ClippingProcessor::consolidate_coplanar(candidate);
        crate::resource::check_current()?;
        if union.is_empty() || !mesh_is_closed_exact(&union) {
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.coaxial_preserving_refusals = c.coaxial_preserving_refusals.saturating_add(1));
            return Ok(false);
        }
    }
    let outcome = clipper.subtract_mesh(result, &union);
    crate::resource::check_current()?;
    let Some(cut) = mesh_to_keep(outcome, result) else {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.coaxial_subtract_refusals = c.coaxial_subtract_refusals.saturating_add(1));
        return Ok(false);
    };
    let accepted = accept_cut(result, cut, f64::INFINITY);
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::record(|c| c.coaxial_commits = c.coaxial_commits.saturating_add(u64::from(accepted)));
    Ok(accepted)
}
