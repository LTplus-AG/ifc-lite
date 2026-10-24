// SPDX-License-Identifier: MPL-2.0
//! Ordered opening evidence. Construction is private to the reached controller;
//! processing must authenticate every cut against its sealed numerical ledger.
use super::*;

#[derive(Debug, Clone)]
pub struct RetainedOpeningCut {
    pub product: u32,
    pub host_part: LogicalRetainedSlot,
    pub requested_opening: u32,
    pub opening_ordinal: usize,
    pub cutter_ordinal: usize,
    pub(crate) inputs: [LogicalRetainedValue; 2],
    pub(crate) output: LogicalRetainedValue,
}
impl RetainedOpeningCut {
    pub fn inputs(&self) -> &[LogicalRetainedValue; 2] { &self.inputs }
    pub fn output(&self) -> &LogicalRetainedValue { &self.output }
}
#[derive(Debug)]
pub struct RetainedOpeningCompletion {
    pub(crate) product: u32,
    pub(crate) related: usize,
    pub(crate) cuts: Vec<RetainedOpeningCut>,
    pub(crate) empty_host: bool,
}
impl RetainedOpeningCompletion {
    pub fn product(&self) -> u32 { self.product }
    pub fn related_openings(&self) -> usize { self.related }
    pub fn accepted_cuts(&self) -> u64 { self.cuts.len() as u64 }
    pub fn empty_host(&self) -> bool { self.empty_host }
    pub fn grouping_deferred(&self) -> bool { true }
    /// Provisional effect candidates, not permission to mutate a router. The
    /// source/owner-bound processing witness owns the sealed receipts; a future
    /// terminal publisher must validate protection policy before committing once.
    pub fn provisional_consumed_parts(&self) -> impl Iterator<Item = LogicalRetainedSlot> + '_ {
        self.cuts.iter().filter(|cut| cut.output.is_empty()).map(|cut| cut.host_part)
    }
    pub fn cuts(&self) -> &[RetainedOpeningCut] { &self.cuts }
}
