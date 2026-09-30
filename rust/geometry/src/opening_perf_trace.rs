// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in #6516 actual-work counters, outside speculative telemetry rollback.
//! Fixed storage, no clock, source identity, names, coordinates or raw logs.
//! The diagnostic caller drains after each canonical job; totals alone do not
//! establish which route dominates time. Never enabled by a shipping feature.

use std::cell::RefCell;
use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    /// Operand arity buckets: zero, one, two, three, four-or-more.
    pub union_calls_by_arity: [u64; 5],
    pub coordinate_preserving_unions: u64,
    pub union_arrangements: u64,
    pub union_operand_triangles: u64,
    pub union_initial_budget_trips: u64,
    pub union_retry_eligible: u64,
    pub union_triangle_cap_exclusions: u64,
    pub union_closure_checks: u64,
    pub union_closure_passes: u64,
    pub union_retries: u64,
    pub union_retry_successes: u64,
    pub union_retries_exhausted: u64,
    pub staged_mixed_attempts: u64,
    pub staged_planar_refusals: u64,
    pub staged_correction_cutters: u64,
    pub staged_disabled_correction_refusals: u64,
    pub staged_residual_calls: u64,
    pub staged_correction_refusals: u64,
    pub staged_topology_refusals: u64,
    pub staged_commits: u64,
    pub prism_attempts: u64,
    /// Same documented reason order as take_prism_defers; actual attempts,
    /// including work later discarded by a staged route.
    pub prism_defers: [u64; 10],
    pub prism_candidate_successes: u64,
    pub prism_candidate_openings: u64,
    pub prism_residual_openings: u64,
    pub single_subtract_calls: u64,
    pub single_changed_results: u64,
    pub single_retessellated_results: u64,
    pub single_retessellated_input_triangles: u64,
    pub single_retessellated_output_triangles: u64,
    pub group_subtract_calls: u64,
    /// subtract, union, intersection, clip; includes speculative operations.
    pub csg_operations: [u64; 4],
    pub csg_operand_triangles: [u64; 4],
    /// KernelError (open-topology accept), KernelOutputInvalid,
    /// OperandTooLarge, other. No error text; an entry need not mean rejection.
    pub csg_failures: [u64; 4],
    pub coaxial_union_attempts: u64,
    pub coaxial_promoted_refusals: u64,
    pub coaxial_preserving_refusals: u64,
    pub coaxial_subtract_refusals: u64,
    pub coaxial_commits: u64,
    /// EmptyHost, NoOverlap, BudgetTripped, Nonconforming, Unchanged,
    /// InvalidOutput, GateRejected. Actual group attempts, including rollback.
    pub group_rejections: [u64; 7],
    pub batch_conforming_arrangements: u64,
    pub batch_nonconforming_arrangements: u64,
    pub batch_conforming_misses: u64,
    pub batch_volume_checked_misses: u64,
    pub batch_weld_preserves_kernel_triangles: u64,
    pub batch_weld_changes_kernel_triangles: u64,
    pub aabb_fallback_attempts: u64,
    pub aabb_fallback_commits: u64,
    pub aabb_fallback_input_triangles: u64,
    pub aabb_fallback_output_triangles: u64,
}

thread_local! {
    static COUNTERS: RefCell<Counters> = RefCell::new(Counters::default());
}

#[doc(hidden)]
pub(crate) fn record(update: impl FnOnce(&mut Counters)) {
    COUNTERS.with(|c| update(&mut c.borrow_mut()));
}

/// Drain only the calling worker. Fixed-size counters cannot retain model data.
#[doc(hidden)]
pub fn take() -> Counters {
    COUNTERS.with(|c| std::mem::take(&mut *c.borrow_mut()))
}
