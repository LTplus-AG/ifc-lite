// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Dropped-representation-item counter (split out of `diagnostics.rs`, #C1
//! module-size ratchet). See `GeometryRouter::record_unsupported_item` /
//! `take_unsupported_items` for the write/drain side and `GeometryDiagnostics`
//! for the wire shape this feeds.

use super::{GeometryRouter, ReasonCount};
use rustc_hash::{FxHashMap, FxHashSet};

/// All dropped-representation-item state, behind one `RefCell` on the router:
/// the counts themselves, the sources already counted, and the open
/// [`GeometryRouter::enter_unsupported_source`] scopes. One struct rather than
/// three fields because `router/mod.rs` sits exactly at its module-size budget,
/// and because the three are meaningless apart.
#[derive(Default)]
pub(crate) struct UnsupportedItemState {
    /// Dropped items (no processor / errored), by `IfcType`. Drained per
    /// element or batch by `take_unsupported_items`.
    counts: FxHashMap<String, u64>,
    /// `IfcRepresentationMap` source ids already counted, so a source is
    /// counted ONCE however many `IfcMappedItem` occurrences walk it.
    sources_recorded: FxHashSet<u32>,
    /// One "record drops beneath this source?" decision per open scope.
    scope: Vec<bool>,
}

impl UnsupportedItemState {
    /// Forget which sources have been counted, so a re-walk counts them again.
    pub(crate) fn forget_sources(&mut self) {
        self.sources_recorded.clear();
    }
}

impl GeometryRouter {
    /// Enter a `RepresentationMap` source's item walk, returning a scope guard.
    ///
    /// Two things are decided once, here, instead of at each write site beneath:
    ///
    /// * **Per SOURCE, not per occurrence.** The contract this counter promises
    ///   (`GeometryDiagnostics.totalUnsupportedItems`, and the drain doc below)
    ///   is that a drop inside a source is counted ONCE however many
    ///   `IfcMappedItem` occurrences reuse it. The mapped-item cache delivers
    ///   that only for a source that produced geometry: a source whose items ALL
    ///   drop meshes to empty, and the empty-mesh guard on both cache inserts
    ///   (`mapped_item.rs`, `instancing.rs`) then skips it, so every occurrence
    ///   re-walks and re-counted it. `unsupported_sources_recorded` closes that:
    ///   the FIRST walk of a source claims it and records; later walks, by any
    ///   path, record nothing.
    /// * **Body representations only.** A type's 2D 'FootPrint'/'Annotation' map
    ///   carries `IfcAnnotationFillArea`/`IfcGeometricCurveSet`, which have no
    ///   processor and are CORRECTLY absent from a 3D view; counting them warns
    ///   on a clean model. `is_body` false suppresses every record beneath the
    ///   scope and does NOT claim the source, so the same source reached later
    ///   under a Body representation still counts.
    ///
    /// Deciding it here rather than at each `record_unsupported_item` call is
    /// what makes it hold on the OCCURRENCE path: a mapped source's unsupported
    /// item is not recorded by the mapped-item branch at all, it is recorded by
    /// `collect_submeshes_from_item_inner`'s own plain-item arm one recursion
    /// level down. A per-site gate at the mapped-item branch would never see it.
    ///
    /// Scoped to this router, like `mapped_item_cache`: the native pool builds a
    /// fresh router per element, so two elements sharing a TOTAL-LOSS source
    /// still contribute one each. Every source that yields any geometry is
    /// shared model-wide through `shared_mapped_item_cache` and walked once.
    pub(crate) fn enter_unsupported_source(
        &self,
        source_id: u32,
        is_body: bool,
    ) -> UnsupportedSourceScope<'_> {
        let mut state = self.unsupported.borrow_mut();
        let record = is_body && state.sources_recorded.insert(source_id);
        state.scope.push(record);
        UnsupportedSourceScope { router: self }
    }

    /// Record one dropped representation item (unsupported type, or its
    /// processor errored), keyed by `IfcType`.
    ///
    /// Suppressed while inside an [`enter_unsupported_source`] scope that
    /// declined to record — a non-Body source, or one already counted. Outside
    /// any scope (an element's own representation item) it always records.
    ///
    /// [`enter_unsupported_source`]: Self::enter_unsupported_source
    pub(crate) fn record_unsupported_item(&self, ifc_type: ifc_lite_core::IfcType) {
        let mut state = self.unsupported.borrow_mut();
        if state.scope.last() == Some(&false) {
            return;
        }
        *state.counts.entry(ifc_type.to_string()).or_insert(0) += 1;
    }

    /// Drain the dropped-item counts gathered since the last call.
    ///
    /// Does NOT forget the sources already counted: the drain moves counts to
    /// the caller, it does not un-see them. That happens with the mapped-item
    /// cache this mirrors (`set_tessellation_quality`), since a re-tessellation
    /// re-walks every source.
    pub fn take_unsupported_items(&self) -> FxHashMap<String, u64> {
        std::mem::take(&mut self.unsupported.borrow_mut().counts)
    }
}

/// Guard returned by [`GeometryRouter::enter_unsupported_source`]. Pops on drop,
/// so a `?` out of the middle of a source walk cannot leave the scope stack
/// unbalanced. Nested maps stack: a drop is attributed to the INNERMOST source
/// being walked, which is the one that owns the item.
pub(crate) struct UnsupportedSourceScope<'a> {
    router: &'a GeometryRouter,
}

impl Drop for UnsupportedSourceScope<'_> {
    fn drop(&mut self) {
        self.router.unsupported.borrow_mut().scope.pop();
    }
}

/// The human-facing `type=count` breakdown, count-desc then name, as one line.
///
/// Shared so the wasm console warning and the native `tracing::warn!` cannot
/// drift: they previously each re-derived this and had already diverged on the
/// separator (comma vs space). Both also sorted on count alone, which leaves
/// ties ordered by `FxHashMap` iteration — so two runs over the same model could
/// print different strings. [`summarize`] breaks ties by name, so this is stable.
/// The per-surface prefix text stays at the call site; only the list is shared.
pub fn format_unsupported_breakdown(items: &FxHashMap<String, u64>) -> String {
    let (_total, by_type) = summarize(items);
    by_type
        .iter()
        .map(|rc| format!("{}={}", rc.reason, rc.count))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Fold a drained unsupported-item map into `(total, by_type sorted desc)`.
pub fn summarize(items: &FxHashMap<String, u64>) -> (u64, Vec<ReasonCount>) {
    let total = items.values().sum();
    let mut by_type: Vec<ReasonCount> = items
        .iter()
        .map(|(ifc_type, count)| ReasonCount { reason: ifc_type.clone(), count: *count })
        .collect();
    by_type.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
    (total, by_type)
}
