// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Stage C, the exact tail: the opening state the coaxial union, the
//! disjoint batch and the sequential cuts share while they cut one host.

use crate::csg::ClippingProcessor;
use crate::program::openings::execute::Execution;
use crate::router::voids::CutterKind;
use crate::Mesh;
use rustc_hash::FxHashMap;

mod batch;
mod batch_plan;

/// One host's exact-tail bookkeeping, indexed like the prepared openings.
pub(in crate::router::voids) struct ExactState {
    /// Openings already cut (by the coaxial union or a batched group); the
    /// later passes skip them.
    pub(in crate::router::voids) consumed: Vec<bool>,
    /// Disjoint groups of opening indices (len >= 2 only); each is cut INLINE
    /// at its first member's position in the sequential loop, so the relative
    /// order of batched vs sequential cutters matches the pure sequential
    /// pass — only the order WITHIN a group (mutually disjoint cutters, the
    /// provably order-free case) is collapsed.
    groups: Vec<Vec<(usize, Mesh)>>,
    group_of: FxHashMap<usize, usize>,
    /// Set on every successful cut; while false, a group's admission-time
    /// extended cutters are still valid and reused verbatim.
    pub(in crate::router::voids) host_mutated: bool,
}

impl ExactState {
    pub(in crate::router::voids) fn new(opening_count: usize) -> Self {
        Self {
            consumed: vec![false; opening_count],
            groups: Vec::new(),
            group_of: FxHashMap::default(),
            host_mutated: false,
        }
    }

    /// The coaxial footprint-union prepass over the whole opening set, which
    /// marks what it cut consumed and records whether the host changed.
    pub(in crate::router::voids) fn coaxial_union(
        &mut self,
        execution: &Execution,
        result: &mut Mesh,
        all_openings: &[&CutterKind],
        clipper: &ClippingProcessor,
    ) {
        execution.coaxial_union_prepass(result, all_openings, &mut self.consumed, &mut self.host_mutated, clipper);
    }
}
