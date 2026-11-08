// SPDX-License-Identifier: MPL-2.0
//! Per-controller logical work, independent of allocation/cancellation policy.
//! Cache hits and placeholders pay attempts, but skip unmaterialized children.
//! Every mapped attempt pays: it expands a shared source. A first Items read
//! pays for its repeated references; a repeated one pays in full (#9102,
//! `representation::first_seen`).
use crate::representation::first_seen::FirstSeen;
use crate::Error;
use std::sync::Arc;

// Keep successful per-attempt Results pointer-sized. Allocate detail only on
// refusal; growing the error payload must not grow every accepted reply.
#[derive(Debug)]
#[repr(transparent)]
pub(crate) struct LogicalRefusal(Box<LogicalRefusalDetail>);

const _: () = assert!(
    std::mem::size_of::<std::result::Result<(), LogicalRefusal>>()
        == std::mem::size_of::<usize>()
);

#[derive(Debug)]
struct LogicalRefusalDetail {
    limit: u32,
    reached: u64,
    budget: &'static str,
}
impl LogicalRefusal {
    pub(super) fn details(&self) -> (&'static str, u32, u64) { (self.0.budget, self.0.limit, self.0.reached) }
    pub(super) fn to_error(&self, item: u32) -> Error {
        crate::representation::WalkRefusal::Budget {
            max_levels: self.0.limit,
            budget: self.0.budget,
            reached: Box::new(self.0.reached),
        }
        .into_error(item)
    }
}

pub(crate) enum SourceFailure {
    Content(Error),
    Budget(LogicalRefusal),
}
pub(crate) type SourceResult<T> = std::result::Result<T, SourceFailure>;
impl From<Error> for SourceFailure {
    fn from(error: Error) -> Self {
        Self::Content(error)
    }
}
impl From<ifc_lite_core::Error> for SourceFailure {
    fn from(error: ifc_lite_core::Error) -> Self {
        Self::Content(error.into())
    }
}
impl From<LogicalRefusal> for SourceFailure {
    fn from(refusal: LogicalRefusal) -> Self {
        Self::Budget(refusal)
    }
}

/// The counters travel by value through speculative replies, and so do the
/// list reads (#9102): an execution records them in `pending`, and only the
/// accepted reply's budget folds them into `seen`, at the next [`commit`].
/// A discarded reply therefore never turns a later first read into a repeat.
///
/// [`commit`]: LogicalBudget::commit
#[derive(Clone)]
pub(crate) struct LogicalBudget {
    limit: u32,
    maps: u32,
    items: u32,
    seen: Arc<FirstSeen>,
    pending: smallvec::SmallVec<[u32; 2]>,
}
impl Default for LogicalBudget {
    fn default() -> Self {
        Self {
            limit: crate::representation::MAX_WALK_LEVELS,
            maps: 0,
            items: 0,
            seen: Arc::default(),
            pending: smallvec::SmallVec::new(),
        }
    }
}
impl LogicalBudget {
    fn debit(used: &mut u32, count: usize, limit: u32) -> std::result::Result<(), LogicalRefusal> {
        let next = u32::try_from(count)
            .ok()
            .and_then(|count| used.checked_add(count))
            .filter(|next| *next <= limit)
            .ok_or_else(|| LogicalRefusal(Box::new(LogicalRefusalDetail { limit, reached: u64::from(*used).saturating_add(count as u64), budget: "logical Items members" })))?;
        *used = next;
        Ok(())
    }
    /// Fold this (accepted) budget's reads into `seen`. Every speculative copy
    /// is taken after a commit, so `pending` holds at most one step's reads.
    pub(crate) fn commit(&mut self) {
        if !self.pending.is_empty() {
            let seen = Arc::make_mut(&mut self.seen);
            for rep in self.pending.drain(..) {
                seen.insert(rep);
            }
        }
    }
    /// Enter a mapped item. Every attempt pays, distinct item or not: each one
    /// expands a shared source, so it is the amplifier this meter bounds.
    pub(super) fn mapped_attempt(&mut self) -> std::result::Result<(), LogicalRefusal> {
        Self::debit(&mut self.maps, 1, self.limit).map_err(|mut refusal| { refusal.0.budget = "logical mapped attempts"; refusal })
    }
    /// Materialize representation `rep`'s Items `members`. A repeated list
    /// pays every member, and a first read every repeated reference within
    /// it, all before anything is resolved (#9102).
    pub(crate) fn materialize_items(
        &mut self,
        rep: u32,
        members: &[ifc_lite_core::AttributeValue],
    ) -> std::result::Result<(), LogicalRefusal> {
        let charge = self.seen.price(&self.pending, rep, members);
        Self::debit(&mut self.items, charge.cost, self.limit)?;
        if !self.pending.contains(&charge.rep) {
            self.pending.push(charge.rep);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn with_limit(limit: u32) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }
    /// Test seam: make the next read of `rep`'s Items a repeat (#9102).
    #[cfg(test)]
    pub(super) fn mark_seen(&mut self, rep: u32) {
        Arc::make_mut(&mut self.seen).insert(rep);
    }
}
