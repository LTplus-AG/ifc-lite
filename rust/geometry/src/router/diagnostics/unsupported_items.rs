// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Dropped-representation-item counter (split out of `diagnostics.rs`, #C1
//! module-size ratchet). See `GeometryRouter::record_unsupported_item` /
//! `take_unsupported_items` for the write/drain side and `GeometryDiagnostics`
//! for the wire shape this feeds.

use super::{GeometryRouter, ReasonCount};
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Record one dropped representation item (unsupported type, or its
    /// processor errored), keyed by `IfcType`.
    ///
    /// Lower bound, not an exact instance count: a `RepresentationMap` source
    /// is walked once and then served from the mapped-item cache, so a drop
    /// inside that source is counted once no matter how many `IfcMappedItem`
    /// occurrences reuse it. That is enough for "something was dropped, and of
    /// this type", which is what this counter exists to answer; it must not be
    /// read as the number of affected occurrences.
    pub(crate) fn record_unsupported_item(&self, ifc_type: ifc_lite_core::IfcType) {
        *self.unsupported_items.borrow_mut().entry(ifc_type.to_string()).or_insert(0) += 1;
    }

    /// Drain the dropped-item counts gathered since the last call.
    pub fn take_unsupported_items(&self) -> FxHashMap<String, u64> {
        std::mem::take(&mut *self.unsupported_items.borrow_mut())
    }
}

/// Fold a drained unsupported-item map into `(total, by_type sorted desc)`.
pub(super) fn summarize(items: &FxHashMap<String, u64>) -> (u64, Vec<ReasonCount>) {
    let total = items.values().sum();
    let mut by_type: Vec<ReasonCount> = items
        .iter()
        .map(|(ifc_type, count)| ReasonCount { reason: ifc_type.clone(), count: *count })
        .collect();
    by_type.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
    (total, by_type)
}
