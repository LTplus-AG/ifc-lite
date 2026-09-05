// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native scan indexes. Keep the public supplied-hash-index contract while
//! avoiding hash bucket padding for large sources with 32-bit byte offsets.

use std::sync::Arc;
use ifc_lite_core::{ColumnarEntityIndex, DenseEntityIndex, EntityDecoder, EntityIndex};
use rustc_hash::FxHashMap;

#[derive(Clone)]
pub(super) enum ProcessingIndex {
    Hash(Arc<EntityIndex>),
    Columnar(Arc<ColumnarEntityIndex>),
    Dense(Arc<DenseEntityIndex>),
}

impl ProcessingIndex {
    pub(super) fn decoder<'a>(&self, content: &'a [u8]) -> EntityDecoder<'a> {
        let mut decoder = EntityDecoder::new(content);
        self.install(&mut decoder);
        decoder
    }

    pub(super) fn install(&self, decoder: &mut EntityDecoder<'_>) {
        match self {
            Self::Hash(index) => decoder.set_entity_index(index.clone()),
            Self::Columnar(index) => decoder.set_columnar_index(index.clone()),
            Self::Dense(index) => decoder.set_dense_index(index.clone()),
        }
    }
}

type Row = (u32, u32, u32);
const PAGE_ROWS: usize = 4096;

pub(super) enum IndexBuilder {
    Hash(EntityIndex),
    Compact { pages: Vec<Vec<Row>>, len: usize },
}

fn compact_eligible(content_len: usize) -> bool {
    cfg!(not(target_arch = "wasm32"))
        && content_len >= 32 * 1024 * 1024 && u32::try_from(content_len).is_ok()
}

impl IndexBuilder {
    pub(super) fn new(content_len: usize, build: bool) -> Self {
        if build && compact_eligible(content_len) {
            Self::Compact { pages: Vec::new(), len: 0 }
        } else {
            Self::Hash(FxHashMap::with_capacity_and_hasher(
                if build { content_len / 50 } else { 0 }, Default::default()))
        }
    }

    pub(super) fn insert(&mut self, id: u32, span: (usize, usize)) {
        match self {
            Self::Hash(index) => { index.insert(id, span); }
            Self::Compact { pages, len } => {
                debug_assert!(span.0 <= span.1 && u32::try_from(span.1).is_ok());
                if pages.last().is_none_or(|page| page.len() == PAGE_ROWS) {
                    pages.push(Vec::with_capacity(PAGE_ROWS));
                }
                pages.last_mut().expect("a page was allocated")
                    .push((id, span.0 as u32, (span.1 - span.0) as u32));
                *len += 1;
            }
        }
    }

    pub(super) fn finish(self) -> ProcessingIndex {
        match self {
            Self::Hash(index) => ProcessingIndex::Hash(Arc::new(index)),
            Self::Compact { pages, len } => {
                // Fixed pages avoid geometric Vec over-allocation. At most
                // two 12-byte representations overlap; release each consumed
                // page as the contiguous sort input fills.
                let mut rows = Vec::with_capacity(len);
                for page in pages { rows.extend(page); }
                // Scanner spans increase in file order. Sorting ties by start
                // retains the last authored occurrence without a permutation
                // array or a stable-sort scratch allocation.
                rows.sort_unstable_by_key(|row| (row.0, row.1));
                rows.dedup_by(|later, earlier| {
                    if later.0 != earlier.0 { return false; }
                    *earlier = *later;
                    true
                });
                let mut ids = Vec::with_capacity(rows.len());
                let mut starts = Vec::with_capacity(rows.len());
                let mut lengths = Vec::with_capacity(rows.len());
                for (id, start, length) in rows {
                    ids.push(id); starts.push(start); lengths.push(length);
                }
                match DenseEntityIndex::try_from_columns(&ids, &starts, &lengths) {
                    Some(index) => ProcessingIndex::Dense(Arc::new(index)),
                    None => ProcessingIndex::Columnar(Arc::new(
                        ColumnarEntityIndex::from_columns(&ids, &starts, &lengths))),
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "entity_index_tests.rs"]
mod tests;
