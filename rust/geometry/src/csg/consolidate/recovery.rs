// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One established emission path and one bounded remote-plane retry.

use super::plane_merge::PlaneTri;
use super::{candidates, plan, plans::Planned, preservation, supported_cells};
use crate::mesh::Mesh;
use std::collections::BTreeMap;

mod closure;

/// Optional repair is restricted to consolidation tearing a closed input.
/// A closed established output is a compatibility boundary, even when a new
/// source-plane choice could produce different, equally closed geometry.
pub(super) fn retry_closed_input(
    input: &Mesh,
    baseline: Mesh,
    buckets: &BTreeMap<(i64, i64, i64, i64), Vec<PlaneTri>>,
    mut planned: Planned,
    length_unit_scale: f64,
    supported: &supported_cells::Supported,
) -> Mesh {
    if !planned.plans.iter().any(|plan| plan.retry.is_some()) {
        return baseline;
    }
    if closure::is_closed(&baseline) {
        crate::diag::diag_debug!(
            { "remote-plane retry declined: established output is strictly closed" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[ifc-lite] remote-plane retry declined: established output is strictly closed");
            }
        );
        return baseline;
    }
    let source = match closure::closed_signature(input) {
        Ok(signature) => signature,
        Err(_reason) => {
            crate::diag::diag_debug!(
                { reason = ?_reason, "remote-plane retry declined: input" }
                else {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!("[ifc-lite] remote-plane retry declined: input={_reason:?}");
                }
            );
            return baseline;
        }
    };
    let mut next_bid = planned.plans.iter().map(|plan| plan.bid).max().unwrap_or(0) + 1;
    let mut replacement = Vec::with_capacity(planned.plans.len());
    let mut changed = false;
    // Positional pairing is exact: `buckets::build` creates a key only by
    // pushing a triangle, the merge pass removes an absorbed key instead of
    // emptying it, and `plans::build` pushes one plan per bucket with
    // `bid` equal to the bucket index.
    debug_assert!(
        planned.plans.len() == buckets.len()
            && planned.plans.iter().enumerate().all(|(i, plan)| plan.bid as usize == i)
    );
    for ((_, tris), mut previous) in buckets.iter().zip(planned.plans) {
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
        crate::diag::diag_debug!(
            { "remote-plane retry declined: no certified separated groups" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[ifc-lite] remote-plane retry declined: no certified separated groups");
            }
        );
        return baseline;
    }
    // Protected plans have no retry. Keep their original bids and retained
    // cells in the shared emitter so an unrelated repair cannot drop a thin
    // source cell or conform away a certified fold.
    planned.plans = replacement;
    let Some(candidate) = candidates::emit(&mut planned, buckets, supported) else {
        crate::diag::diag_debug!(
            { "remote-plane retry declined: incomplete triangulation" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[ifc-lite] remote-plane retry declined: incomplete triangulation");
            }
        );
        return baseline;
    };
    let signature = closure::closed_signature(&candidate);
    crate::diag::diag_debug!(
        { ?source, candidate = ?signature, "remote-plane retry signatures" }
        else {
            #[cfg(feature = "debug_geometry")]
            eprintln!("[ifc-lite] remote-plane retry source={source:?} candidate={signature:?}");
        }
    );
    if signature.as_ref() == Ok(&source)
        && preservation::public_weld_closed(&candidate)
        && !preservation::signed_boundary_worse(&candidate, &baseline)
        && !supported_cells::has_uncertified_needle(&candidate, supported)
    {
        candidate
    } else {
        baseline
    }
}
