// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The entity index an [`EntityDecoder`](crate::EntityDecoder) reads through,
//! whichever representation is installed.

use std::sync::Arc;

/// The index representation an [`EntityDecoder`](crate::EntityDecoder) holds:
/// either the legacy `FxHashMap` (native / lazily-built paths) or the compact
/// columnar index (wasm shared-index ingestion). A thin dispatch keeps the
/// decoder hot path (`decode_by_id`) agnostic to which one is installed.
pub(crate) enum EntityIndexStore {
    Hash(Arc<crate::EntityIndex>),
    Columnar(Arc<crate::ColumnarEntityIndex>),
    Dense(Arc<crate::DenseEntityIndex>),
}

impl EntityIndexStore {
    /// Resolve `id` to its `(start, end)` byte span.
    #[inline]
    pub(crate) fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        match self {
            EntityIndexStore::Hash(m) => m.get(&id).copied(),
            EntityIndexStore::Columnar(c) => c.lookup(id),
            EntityIndexStore::Dense(d) => d.lookup(id),
        }
    }
}
