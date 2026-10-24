// SPDX-License-Identifier: MPL-2.0
//! What a plan removed from the output and why, as [`super::WriteReport`]
//! reports it, so a caller reconciling its own model with the file reads
//! the executor's reason instead of predicting it.
//!
//! A record that went for more than one reason reports the first of them in
//! [`RemovalReason`]'s order: a record both requested and orphaned is
//! `Requested`, an opening that both lost its host relationship and named a
//! removed placement is `Unhosted`. The delete cascade walks the plan's
//! deletes in id order, so the same plan reports the same reasons on every
//! run. It costs one map entry per removal, recorded where the removal
//! already happens.

/// Why a record is not in the output, most telling first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum RemovalReason {
    /// The plan deletes it (`Disposition::Delete`).
    Requested,
    /// A patch replaced it: an old placement chain, a product's old body
    /// and what annotated it, or a relationship the patch's object moved
    /// out of.
    Replaced,
    /// An opening or projection left without its host relationship: IFC ties
    /// each to exactly one element.
    Unhosted,
    /// It names a removed record through a single-valued attribute (a
    /// relationship whose relating object went, a placement relative to a
    /// removed one), so it cannot be written without a dangling reference.
    Dangling,
    /// A relationship or presentation layer whose mandatory member list the
    /// plan's deletes emptied. One a patch's copy-on-write emptied by moving
    /// its object to a new relationship is `Replaced`.
    Emptied,
    /// Nothing refers to it once the records that used it went: a property
    /// set, a placement chain, geometry.
    Released,
}

/// One record the plan removed, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Removal {
    /// Its express id in the source.
    pub express_id: u32,
    pub reason: RemovalReason,
}

impl RemovalReason {
    /// The reason a record that went for both `self` and `other` reports.
    pub(crate) fn first(self, other: Self) -> Self {
        self.min(other)
    }
}

impl Removal {
    pub fn new(express_id: u32, reason: RemovalReason) -> Self {
        Self { express_id, reason }
    }
}

#[cfg(test)]
#[path = "removal_tests.rs"]
mod tests;
