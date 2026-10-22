// SPDX-License-Identifier: MPL-2.0
//! Per-controller logical work, independent of allocation/cancellation policy.
//! Cache hits and placeholders pay attempts, but skip unmaterialized children.
use crate::Error;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LogicalRefusal { limit: u32 }
impl LogicalRefusal {
    pub(super) fn into_error(self, item: u32) -> Error {
        crate::representation::WalkRefusal::Budget { max_levels: self.limit }.into_error(item)
    }
}

pub(crate) enum SourceFailure { Content(Error), Budget(LogicalRefusal) }
pub(crate) type SourceResult<T> = std::result::Result<T, SourceFailure>;
impl From<Error> for SourceFailure {
    fn from(error: Error) -> Self { Self::Content(error) }
}
impl From<ifc_lite_core::Error> for SourceFailure {
    fn from(error: ifc_lite_core::Error) -> Self { Self::Content(error.into()) }
}
impl From<LogicalRefusal> for SourceFailure {
    fn from(refusal: LogicalRefusal) -> Self { Self::Budget(refusal) }
}

#[derive(Clone, Copy)]
pub(crate) struct LogicalBudget {
    limit: u32,
    maps: u32,
    items: u32,
}
impl Default for LogicalBudget {
    fn default() -> Self {
        Self { limit: crate::representation::MAX_WALK_LEVELS, maps: 0, items: 0 }
    }
}
impl LogicalBudget {
    fn debit(used: &mut u32, count: usize, limit: u32) -> std::result::Result<(), LogicalRefusal> {
        let next = u32::try_from(count).ok().and_then(|count| used.checked_add(count))
            .filter(|next| *next <= limit).ok_or(LogicalRefusal { limit })?;
        *used = next;
        Ok(())
    }
    pub(super) fn mapped_attempt(&mut self) -> std::result::Result<(), LogicalRefusal> {
        Self::debit(&mut self.maps, 1, self.limit)
    }
    pub(crate) fn materialize_items(&mut self, count: usize) -> std::result::Result<(), LogicalRefusal> {
        Self::debit(&mut self.items, count, self.limit)
    }
    #[cfg(test)]
    pub(super) fn with_limit(limit: u32) -> Self { Self { limit, ..Self::default() } }
}

