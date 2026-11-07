// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Serial scan owns one table. Metadata borrows it through a temporary Arc;
//! dropping that decoder restores exclusive insertion without copying entries.
use ifc_lite_core::{ColumnarEntityIndex, EntityDecoder, EntityIndex};
use std::sync::Arc;

pub(super) struct SerialIndex(Arc<EntityIndex>);

impl SerialIndex {
    pub(super) fn new(source_len: usize) -> Self {
        // #8259: bound up-front reservation on wasm32. Metadata never copies
        // this reservation, nor the populated rows. Sharded scans use no table.
        const RESERVE_CAP: usize = 40_000_000;
        Self(Arc::new(EntityIndex::with_capacity_and_hasher(
            (source_len / 50).min(RESERVE_CAP),
            Default::default(),
        )))
    }

    pub(super) fn insert(&mut self, id: u32, start: usize, end: usize) {
        Arc::get_mut(&mut self.0)
            .expect("metadata decoder released before scan resumes")
            .insert(id, (start, end));
    }

    pub(super) fn decoder<'a>(&self, content: &'a [u8]) -> EntityDecoder<'a> {
        EntityDecoder::with_arc_index(content, self.0.clone())
    }

    pub(super) fn into_columns(self) -> Result<ColumnarEntityIndex, String> {
        let index =
            Arc::try_unwrap(self.0).expect("metadata decoder released before column conversion");
        ColumnarEntityIndex::from_hashmap_consuming(index).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "c4_11b_prepass_tests.rs"]
mod tests;
