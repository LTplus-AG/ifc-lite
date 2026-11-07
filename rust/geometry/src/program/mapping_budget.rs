// SPDX-License-Identifier: MPL-2.0
//! Per-controller logical work, independent of allocation/cancellation policy.
//! Cache hits and placeholders pay attempts, but skip unmaterialized children.
//! Every mapped attempt pays: it expands a shared source. Only repeated Items
//! lists pay; a first read is bounded by the file (#9102, `representation::first_seen`).
use crate::representation::first_seen::FirstSeen;
use crate::Error;
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LogicalRefusal {
    limit: u32,
}
impl LogicalRefusal {
    pub(super) fn into_error(self, item: u32) -> Error {
        crate::representation::WalkRefusal::Budget {
            max_levels: self.limit,
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
/// first list reads (#9102): an execution records them in `pending`, and only
/// the accepted reply's budget folds them into `seen`, at the next [`commit`].
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
            .ok_or(LogicalRefusal { limit })?;
        *used = next;
        Ok(())
    }
    fn first_list(&mut self, rep: u32) -> bool {
        if self.seen.contains(rep) || self.pending.contains(&rep) {
            return false;
        }
        self.pending.push(rep);
        true
    }
    /// Fold this (accepted) budget's first reads into `seen`. Every speculative
    /// copy is taken after a commit, so `pending` stays a few lists long.
    pub(crate) fn commit(&mut self) {
        if !self.pending.is_empty() {
            let seen = Arc::make_mut(&mut self.seen);
            for rep in self.pending.drain(..) {
                seen.first_list(rep);
            }
        }
    }
    /// Enter a mapped item. Every attempt pays, distinct item or not: each one
    /// expands a shared source, so it is the amplifier this meter bounds.
    pub(super) fn mapped_attempt(&mut self) -> std::result::Result<(), LogicalRefusal> {
        Self::debit(&mut self.maps, 1, self.limit)
    }
    /// Materialize the `count` Items of representation `rep`: a repeated list
    /// pays every member before anything is resolved.
    pub(crate) fn materialize_items(
        &mut self,
        rep: u32,
        count: usize,
    ) -> std::result::Result<(), LogicalRefusal> {
        if self.first_list(rep) {
            return Ok(());
        }
        Self::debit(&mut self.items, count, self.limit)
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
        Arc::make_mut(&mut self.seen).first_list(rep);
    }
}
