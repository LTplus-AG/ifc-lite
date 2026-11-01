// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Stage C, the exact tail: the coaxial union, the disjoint batch, the
//! sequential exact cut and the #635 fallback, run by [`ExactTail::run`] in
//! that order over the prepared cutters of one host.

use crate::csg::ClippingProcessor;
use crate::program::openings::execute::Execution;
use crate::router::voids::CutterKind;
use crate::{Mesh, Point3};
use rustc_hash::FxHashMap;

mod batch;
mod batch_plan;
mod fallback_635;
pub(in crate::router::voids) mod prepare;
mod sequential;

/// One host's exact-tail bookkeeping, indexed like the prepared openings.
pub(in crate::router::voids) struct ExactState {
    /// Openings already cut (by the coaxial union or a batched group); the
    /// later passes skip them.
    consumed: Vec<bool>,
    /// Disjoint groups of opening indices (len >= 2 only); each is cut INLINE
    /// at its first member's position in the sequential loop, so the relative
    /// order of batched vs sequential cutters matches the pure sequential
    /// pass — only the order WITHIN a group (mutually disjoint cutters, the
    /// provably order-free case) is collapsed.
    groups: Vec<Vec<(usize, Mesh)>>,
    group_of: FxHashMap<usize, usize>,
    /// Set on every successful cut; while false, a group's admission-time
    /// extended cutters are still valid and reused verbatim.
    host_mutated: bool,
}

impl ExactState {
    fn new(opening_count: usize) -> Self {
        Self {
            consumed: vec![false; opening_count],
            groups: Vec::new(),
            group_of: FxHashMap::default(),
            host_mutated: false,
        }
    }

    /// The coaxial footprint-union prepass over the whole opening set, which
    /// marks what it cut consumed and records whether the host changed.
    fn coaxial_union(
        &mut self,
        execution: &Execution,
        result: &mut Mesh,
        all_openings: &[&CutterKind],
        clipper: &ClippingProcessor,
    ) {
        execution.coaxial_union_prepass(result, all_openings, &mut self.consumed, &mut self.host_mutated, clipper);
    }
}

/// What every exact pass reads besides the host and the opening.
#[derive(Clone, Copy)]
pub(in crate::router::voids) struct CutContext<'a> {
    pub(in crate::router::voids) execution: &'a Execution,
    pub(in crate::router::voids) clipper: &'a ClippingProcessor,
    /// The host's bounds before the exact passes (the extension reference).
    pub(in crate::router::voids) wall_min: Point3<f64>,
    pub(in crate::router::voids) wall_max: Point3<f64>,
}

/// How the per-opening loop continues after a sequential cut.
enum Flow<'a> {
    /// Cut, or nothing to cut: the next opening.
    Next,
    /// The host was consumed: no opening after this one runs.
    Stop,
    /// The kernel failed on an opening that reaches the host: run #635 now.
    Fallback(fallback_635::Fallback<'a>),
}

/// One host's exact tail: it owns the evolving host and its state, and
/// borrows the prepared cutters for as long as it runs.
pub(in crate::router::voids) struct ExactTail<'a> {
    host: Mesh,
    all_openings: Vec<&'a CutterKind>,
    state: ExactState,
}

impl<'a> ExactTail<'a> {
    pub(in crate::router::voids) fn new(host: Mesh, all_openings: Vec<&'a CutterKind>) -> Self {
        let state = ExactState::new(all_openings.len());
        Self { host, all_openings, state }
    }

    /// Run the exact passes in their frozen order and hand back the host and
    /// whether any pass changed it. The order is the statement order below:
    /// the coaxial union over the whole set, the batch plan over what it left,
    /// then per opening its batch (cut at the group's first member), its
    /// sequential cut and, on a kernel miss, its #635 fallback. Changing it
    /// is a geometry and diagnostics change (`mesh-determinism.md`).
    pub(in crate::router::voids) fn run(mut self, context: CutContext<'_>) -> (Mesh, bool) {
        let CutContext { execution, clipper, wall_min, wall_max } = context;
        let (host, all_openings, state) = (&mut self.host, &self.all_openings, &mut self.state);
        // COAXIAL FOOTPRINT-UNION for OVERLAPPING clusters (issue #129, flag
        // `IFC_LITE_VOID_UNION`). Overlapping cutters can't join the disjoint batch
        // below and otherwise fall to the O(N) sequential exact path; this fuses
        // each overlapping coaxial cluster into disjoint re-extruded prisms and cuts
        // them in one `subtract_mesh_many`. See `coaxial_union`. Marks consumed
        // openings so the batch + sequential loops skip them; a cluster that fails
        // any guard is left unconsumed for the exact path (never worse than exact).
        state.coaxial_union(execution, host, all_openings, clipper);
        state.plan_groups(execution, host, all_openings, wall_min, wall_max);
        for (opening_idx, opening) in all_openings.iter().enumerate() {
            if state.consumed[opening_idx] {
                continue; // already handled by a batched disjoint group
            }
            if state.cut_group(host, all_openings, clipper, opening_idx) {
                continue; // this opening was handled with its group
            }
            match state.cut_one(host, opening, context) {
                Flow::Next => {}
                Flow::Stop => break,
                Flow::Fallback(attempt) => state.fallback_635(host, context, attempt),
            }
        }
        (self.host, self.state.host_mutated)
    }
}
