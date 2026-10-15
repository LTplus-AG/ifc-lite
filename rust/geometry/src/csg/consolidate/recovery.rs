// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One established emission path and one bounded remote-plane retry.

use super::conform::{
    build_seam_map, conform_plans, count_open_boundary_edges_at, emit_plans, PlanBucket,
};
use super::plane_merge::PlaneTri;
use super::{complete_conformed_candidate, plan};
use crate::mesh::Mesh;
use std::collections::BTreeMap;

mod closure;

pub(super) fn emit_and_conform(plans: &mut [PlanBucket]) -> Option<Mesh> {
    let (mut output, base_complete) = emit_plans(plans, false);
    // A region that failed to triangulate is skipped, so an incomplete baseline
    // can be missing a whole closed component while still reading as watertight.
    // Consolidation's standing contract is "never worse than the raw kernel
    // output", so hand back the raw mesh rather than a known-lossy consolidation.
    if !base_complete {
        return None;
    }
    if count_open_boundary_edges_at(&output, 1.0e4) > 0 {
        let seam = build_seam_map(plans);
        if conform_plans(plans, &seam) {
            // `complete` is part of the bar, not a detail: a region that fails
            // to triangulate is skipped, and if it was its own closed component
            // the remainder still balances — so a watertight-LOOKING candidate
            // can be missing a whole surface. Reject unless every region landed.
            let raw_conformed = plans.iter().any(|plan| plan.raw_conformed.is_some());
            let (candidate, complete) = emit_plans(plans, true);
            if let Some(candidate) =
                complete_conformed_candidate(candidate, complete, raw_conformed)
            {
                output = candidate;
            } else if raw_conformed {
                // Preserve the established region-only conform when a new raw
                // split does not pair exactly. This is the #3913 N-ary sweep
                // safety valve: raw additions may improve the 0.1 mm metric
                // while introducing an exact-coordinate tear.
                for plan in plans.iter_mut() {
                    plan.raw_conformed = None;
                }
                let (candidate, complete) = emit_plans(plans, true);
                if let Some(candidate) = complete_conformed_candidate(candidate, complete, false) {
                    output = candidate;
                }
            }
        }
    }
    Some(output)
}

/// Optional repair is restricted to consolidation tearing a closed input.
/// A closed established output is a compatibility boundary, even when a new
/// source-plane choice could produce different, equally closed geometry.
pub(super) fn retry_closed_input(
    input: &Mesh,
    baseline: Mesh,
    buckets: &BTreeMap<(i64, i64, i64, i64), Vec<PlaneTri>>,
    plans: Vec<PlanBucket>,
    length_unit_scale: f64,
) -> Mesh {
    if !plans.iter().any(|plan| plan.retry.is_some()) {
        return baseline;
    }
    if closure::is_closed(&baseline) {
        #[cfg(feature = "debug_geometry")]
        eprintln!("[ifc-lite] remote-plane retry declined: established output is strictly closed");
        return baseline;
    }
    let source = match closure::closed_signature(input) {
        Ok(signature) => signature,
        Err(reason) => {
            #[cfg(feature = "debug_geometry")]
            eprintln!("[ifc-lite] remote-plane retry declined: input={reason:?}");
            #[cfg(not(feature = "debug_geometry"))]
            let _ = reason;
            return baseline;
        }
    };
    let mut next_bid = plans.iter().map(|plan| plan.bid).max().unwrap_or(0) + 1;
    let mut replacement = Vec::with_capacity(plans.len());
    let mut changed = false;
    for ((_, tris), mut previous) in buckets.iter().zip(plans) {
        if plan::append_prepared_retry(
            tris,
            &mut previous,
            &mut next_bid,
            length_unit_scale,
            &mut replacement,
        ) {
            changed = true;
        } else {
            previous.reset_for_retry();
            replacement.push(previous);
        }
    }
    if !changed {
        #[cfg(feature = "debug_geometry")]
        eprintln!("[ifc-lite] remote-plane retry declined: no certified separated groups");
        return baseline;
    }
    let Some(candidate) = emit_and_conform(&mut replacement) else {
        #[cfg(feature = "debug_geometry")]
        eprintln!("[ifc-lite] remote-plane retry declined: incomplete triangulation");
        return baseline;
    };
    let signature = closure::closed_signature(&candidate);
    #[cfg(feature = "debug_geometry")]
    eprintln!("[ifc-lite] remote-plane retry source={source:?} candidate={signature:?}");
    if signature.as_ref() == Ok(&source) {
        candidate
    } else {
        baseline
    }
}
