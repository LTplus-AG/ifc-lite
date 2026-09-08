// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Direct span lookup for dense express ids, without hash-table bucket padding.

use std::sync::Arc;
use crate::{columnar_index::EntityIndexStore, EntityDecoder};

/// Immutable direct-address index for sources whose offsets fit `u32`.
/// Construction refuses sparse ids when its arrays would exceed the three
/// compact input columns. Presence is separate from the span, so id zero and
/// an empty span at offset zero remain valid entries.
pub struct DenseEntityIndex {
    starts: Vec<u32>,
    lengths: Vec<u32>,
    present: Vec<u64>,
}

impl DenseEntityIndex {
    /// Build from strictly ascending, unique ids and parallel span columns.
    /// Returns `None` for mismatched/unsorted columns, empty input, or a sparse
    /// id range. The allocation bound is checked before allocating any array;
    /// a lone `u32::MAX` id cannot request a multi-gigabyte allocation.
    pub fn try_from_columns(ids: &[u32], starts: &[u32], lengths: &[u32]) -> Option<Self> {
        if ids.is_empty() || starts.len() != ids.len() || lengths.len() != ids.len()
            || !ids.windows(2).all(|pair| pair[0] < pair[1]) {
            return None;
        }
        let slots = u64::from(*ids.last()?) + 1;
        let words = slots.div_ceil(64);
        if slots * 8 + words * 8 > ids.len() as u64 * 12 { return None; }
        let slots = usize::try_from(slots).ok()?;
        let mut index = Self {
            starts: vec![0; slots], lengths: vec![0; slots],
            present: vec![0; usize::try_from(words).ok()?],
        };
        for (i, &id) in ids.iter().enumerate() {
            let slot = id as usize;
            index.starts[slot] = starts[i];
            index.lengths[slot] = lengths[i];
            index.present[slot / 64] |= 1u64 << (slot % 64);
        }
        Some(index)
    }

    /// Return the authored `(start, end)` span, or `None` for an absent id.
    #[inline]
    pub fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        let slot = id as usize;
        let start = *self.starts.get(slot)? as usize;
        if self.present[slot / 64] & (1u64 << (slot % 64)) == 0 { return None; }
        Some((start, start + self.lengths[slot] as usize))
    }
}

impl EntityDecoder<'_> {
    /// Install an immutable direct-address index for this decoder's source.
    /// Like `set_columnar_index`, source bytes and indexed spans must agree.
    pub fn set_dense_index(&mut self, index: Arc<DenseEntityIndex>) {
        self.entity_index = Some(EntityIndexStore::Dense(index));
    }
}

#[cfg(test)]
#[path = "dense_index_tests.rs"]
mod tests;
