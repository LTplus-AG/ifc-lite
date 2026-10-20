// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Validate a lenient batch against pristine-host intersection volumes.

use super::BatchSubtract;
use crate::{kernel::{
    arrangement::{boolean, BoolOp, Tri}, budget,
    signed_volume::{signed_volume6, signed_volume6_about, volume_reference},
}, mesh::Mesh};

/// Validate a real lenient arrangement independently of strict-path recovery.
pub(super) fn validate_lenient_batch(
    h: &[Tri], comp_tris: &[Vec<Tri>], batch: &[Tri], changed: bool,
) -> (BatchSubtract, bool, Option<Mesh>) {
    // Fresh oracle budgets cannot certify an aborted batch (#7607).
    if budget::tripped() {
        return (BatchSubtract::Nonconforming, false, None);
    }
    // ORACLE for the volume comparison (#1788): batched cutters are pairwise
    // disjoint (this fn's contract), so the TRUE removed volume is
    // Σ |host ∩ cutterᵢ| — each a small single boolean against the PRISTINE
    // host, the well-conditioned regime. The previous oracle re-ran the
    // sequential subtract chain, but that chain re-jitters its own seams
    // cut-over-cut and UNDER-cuts on multi-void walls — on the ISSUE_098
    // Poroton wall its "reference" removed 2% less volume than the (correct)
    // batch, so a perfect batch was rejected in favour of the broken
    // sequential fallback, leaving an opening uncut (T6 fail:opening-not-cut).
    // Budget snapshot/restore: oracle work isn't charged to the caller's
    // batch budget (codex P2 on #1660); a trip DURING an oracle intersection
    // makes its volume untrustworthy ⇒ reject the group (as before).
    let budget_snap = budget::snapshot_counters();
    let mut inter_sum = 0.0f64;
    let mut oracle_tripped = false;
    for c in comp_tris {
        budget::begin();
        let i = boolean(h, c, BoolOp::Intersection);
        if budget::tripped() {
            oracle_tripped = true;
            break;
        }
        inter_sum += signed_volume6(&i).abs();
    }
    budget::restore_counters(budget_snap);
    if oracle_tripped {
        return (BatchSubtract::Nonconforming, false, None);
    }
    // Both readings about the HOST's reference point (#4693). A host can arrive
    // open (the router does not require a closed host), and an open surface's
    // sum moves with the reference point: read the batch about its own centre
    // and a cut that trims the host's bounding box leaves the untouched crack's
    // flux in `batch_removed`.
    let reference = volume_reference(h);
    let host_v = signed_volume6_about(h, &reference).abs();
    let batch_removed = host_v - signed_volume6_about(batch, &reference).abs();
    // 1% agreement — above f64/FMA noise (parity-stable branch), tight enough to
    // reject the #1167 gross under-cut (3.7 m³ vs 13 m³).
    let tol = inter_sum.abs().max(1.0e-9) * 0.01;
    if (batch_removed - inter_sum).abs() <= tol {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.batch_volume_checked_misses = c.batch_volume_checked_misses.saturating_add(u64::from(!changed)));
        (BatchSubtract::classified(batch, changed), false, None)
    } else {
        (BatchSubtract::Nonconforming, false, None)
    }
}
