// SPDX-License-Identifier: MPL-2.0
//! Per-product facts from the original void control, separate from final fidelity.
use super::openings::retained::GroupEligibility;

#[derive(Debug)]
pub struct RetainedOpeningCompletion {
    product: u32,
    related: usize,
    accepted_cuts: u64,
    empty_host: bool,
    grouping_deferred: bool,
}
impl RetainedOpeningCompletion {
    pub(super) fn new(
        product: u32,
        related: usize,
        accepted_cuts: u64,
        empty_host: bool,
        grouping: Option<GroupEligibility>,
    ) -> Self {
        Self {
            product,
            related,
            accepted_cuts,
            empty_host,
            grouping_deferred: grouping.is_some(),
        }
    }
    pub fn product(&self) -> u32 {
        self.product
    }
    pub fn related_openings(&self) -> usize {
        self.related
    }
    pub fn accepted_cuts(&self) -> u64 {
        self.accepted_cuts
    }
    pub fn empty_host(&self) -> bool {
        self.empty_host
    }
    /// Optimized grouping and mesh classification diagnostics remain unqualified.
    pub fn grouping_deferred(&self) -> bool {
        self.grouping_deferred
    }
}

/// Original ordered opening provenance owned beside each actual sealed cut in
/// processing's acceptance ledger. It survives a later cut/source failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedOpeningCut {
    pub product: u32,
    pub host_part: super::retained::LogicalRetainedSlot,
    pub requested_opening: u32,
    pub opening_ordinal: usize,
    pub cutter_ordinal: usize,
}
