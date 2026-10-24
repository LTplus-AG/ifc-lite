// SPDX-License-Identifier: MPL-2.0
//! What a plan removed from the output and why, as [`super::WriteReport`]
//! reports it, so a caller reconciling its own model with the file reads
//! the executor's reason instead of predicting it.
//!
//! The reason is the one the removal was first made for: a record both
//! requested and orphaned is `Requested`. It costs one map entry per removal,
//! recorded where the removal already happens.

/// Why a record is not in the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RemovalReason {
    /// The plan deletes it (`Disposition::Delete`).
    Requested,
    /// An opening or projection left without its host relationship: IFC ties
    /// each to exactly one element.
    Unhosted,
    /// It names a removed record through a single-valued attribute (a
    /// relationship whose relating object went, a placement relative to a
    /// removed one), so it cannot be written without a dangling reference.
    Dangling,
    /// A relationship or presentation layer whose mandatory member list the
    /// plan's removals emptied.
    Emptied,
    /// Nothing refers to it once the records that used it went: a property
    /// set, a placement chain, geometry.
    Released,
    /// A patch replaced it: an old placement chain, or a product's old body
    /// and what annotated it.
    Replaced,
}

/// One record the plan removed, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Removal {
    /// Its express id in the source.
    pub express_id: u32,
    pub reason: RemovalReason,
}

impl Removal {
    pub fn new(express_id: u32, reason: RemovalReason) -> Self {
        Self { express_id, reason }
    }
}

#[cfg(test)]
#[path = "removal_tests.rs"]
mod tests;
