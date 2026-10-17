// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The express-id allocator every STEP writer here appends records with
//! (#7682, EXPORT-STEP-9): the plain writer's copy-on-write copies and
//! property sets, and the mutation-log writer's generated records.
//!
//! An id is handed out only while one is left. Saturating at `u32::MAX` was
//! worse than the overflow it replaced: on a file that already holds
//! `#4294967295` it handed that id out again, and again for every record after
//! it, so the output carried duplicate ids. A file that has spent the id space
//! has no room for another record, and the caller refuses the edit that needed
//! one instead.

/// Hands out ids past a file's highest one, `None` once they run out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IdAllocator {
    next: Option<u32>,
}

impl IdAllocator {
    /// Ids from `max_id + 1`.
    pub(crate) fn after(max_id: u32) -> Self {
        IdAllocator { next: max_id.checked_add(1) }
    }

    /// The id [`Self::allocate`] would hand out, without taking it.
    pub(crate) fn peek(&self) -> Option<u32> {
        self.next
    }

    /// One id, or `None` when the id space is spent.
    pub(crate) fn allocate(&mut self) -> Option<u32> {
        let id = self.next?;
        self.next = id.checked_add(1);
        Some(id)
    }

    /// The first of `n` consecutive ids, all of them or none: a group of
    /// records that does not fit is refused whole, so nothing half-written
    /// reaches the file.
    pub(crate) fn reserve(&mut self, n: u32) -> Option<u32> {
        let first = self.next?;
        let last = first.checked_add(n.checked_sub(1)?)?;
        self.next = last.checked_add(1);
        Some(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EXPORT-STEP-9 (#7682): the last id is handed out once, then none.
    #[test]
    fn the_last_id_is_handed_out_once() {
        let mut ids = IdAllocator::after(u32::MAX - 1);
        assert_eq!(ids.allocate(), Some(u32::MAX));
        assert_eq!(ids.allocate(), None);
        assert_eq!(ids.allocate(), None);
        assert_eq!(IdAllocator::after(u32::MAX).allocate(), None);
    }

    #[test]
    fn a_reservation_is_all_or_nothing() {
        let mut ids = IdAllocator::after(u32::MAX - 3);
        assert_eq!(ids.reserve(4), None);
        assert_eq!(ids.peek(), Some(u32::MAX - 2), "a refused reservation takes nothing");
        assert_eq!(ids.reserve(3), Some(u32::MAX - 2));
        assert_eq!(ids.peek(), None);
        assert_eq!(IdAllocator::after(5).reserve(0), None);
    }
}
