// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void and aggregate relationship folds: the one kernel behind the
//! production prepass (`ifc_lite_processing::prepass::resolve_prepass`, native
//! and browser) and the standalone geometry scanners in `void_index`.
//!
//! Spans are `(express_id, start, end)` as `EntityScanner::next_entity`
//! yields them. A span that fails to decode, or a relationship missing either
//! end, is skipped.

use crate::void_index::{propagate_voids_to_parts, propagate_voids_via_aggregates};
use ifc_lite_core::{slot, EntityDecoder, EntityScanner};
use rustc_hash::FxHashMap;

/// Visit `(host, opening)` for each `IfcRelVoidsElement` span, in span order,
/// once per relationship (no deduplication).
pub(crate) fn for_each_void_rel(
    spans: &[(u32, usize, usize)],
    decoder: &mut EntityDecoder,
    mut visit: impl FnMut(u32, u32),
) {
    for &(id, start, end) in spans {
        let Ok(rel) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        if let (Some(host), Some(opening)) = (
            rel.ref_at(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT),
            rel.ref_at(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT),
        ) {
            visit(host, opening);
        }
    }
}

/// Fold `IfcRelAggregates` spans into parent → children, children appended in
/// span then authored order. `RelatedObjects` is read bare-tolerant
/// (`DecodedEntity::ref_list_at`): a bare `#id` is a one-element list, and a
/// relationship with no child references adds nothing.
pub(crate) fn fold_aggregate_rels(
    spans: &[(u32, usize, usize)],
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<u32>> {
    let mut aggregate_children: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for &(id, start, end) in spans {
        let Ok(rel) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let Some(parent) = rel.ref_at(slot::IfcRelAggregates::RELATING_OBJECT) else {
            continue;
        };
        if let Some(children) = rel.ref_list_at(slot::IfcRelAggregates::RELATED_OBJECTS) {
            aggregate_children
                .entry(parent)
                .or_default()
                .extend(children);
        }
    }
    aggregate_children
}

/// Canonicalise each host's opening order (#2019). The scan pushes in
/// statement order, aggregate propagation in hashmap-walk order; neither is a
/// property of the model. Sequential void cuts are not associative (each pass
/// snaps f64->f32), so reordering them moves the world geometry hash on a
/// re-export that only shuffled statements.
pub(crate) fn canonicalize_void_order(void_index: &mut FxHashMap<u32, Vec<u32>>) {
    for openings in void_index.values_mut() {
        openings.sort_unstable();
    }
}

/// The production host → openings index: fold the void relationships,
/// propagate them through the aggregate tree (#845), then sort each host's
/// openings (`canonicalize_void_order`). The aggregate spans are decoded only
/// when there is a void to propagate.
pub fn resolve_void_index(
    void_spans: &[(u32, usize, usize)],
    aggregate_spans: &[(u32, usize, usize)],
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for_each_void_rel(void_spans, decoder, |host, opening| {
        void_index.entry(host).or_default().push(opening);
    });
    if !void_index.is_empty() && !aggregate_spans.is_empty() {
        let aggregate_children = fold_aggregate_rels(aggregate_spans, decoder);
        propagate_voids_via_aggregates(&mut void_index, &aggregate_children);
    }
    canonicalize_void_order(&mut void_index);
    void_index
}

/// [`resolve_void_index`] over a whole file: scan `content` for the void and
/// aggregate relationships (keyword in any case) and resolve them. For tests,
/// harnesses and standalone callers that do not run the processing prepass.
pub fn void_index_from_content<T>(
    content: &T,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<u32>>
where
    T: AsRef<[u8]> + ?Sized,
{
    let (void_spans, aggregate_spans) = scan_rel_spans(content.as_ref(), true, true);
    resolve_void_index(&void_spans, &aggregate_spans, decoder)
}

/// Spans of the `IfcRelVoidsElement` and/or `IfcRelAggregates` records in
/// `content`, in file order.
pub(crate) fn scan_rel_spans(
    content: &[u8],
    voids: bool,
    aggregates: bool,
) -> (Vec<(u32, usize, usize)>, Vec<(u32, usize, usize)>) {
    let mut scanner = EntityScanner::new(content);
    let (mut void_spans, mut aggregate_spans) = (Vec::new(), Vec::new());
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if voids && ifc_lite_core::keyword_eq(type_name, "IFCRELVOIDSELEMENT") {
            void_spans.push((id, start, end));
        } else if aggregates && ifc_lite_core::keyword_eq(type_name, "IFCRELAGGREGATES") {
            aggregate_spans.push((id, start, end));
        }
    }
    (void_spans, aggregate_spans)
}

#[cfg(test)]
#[path = "void_rels_tests.rs"]
mod tests;

/// Compute the set of aggregated `IfcBuildingElementPart` ids to skip when the
/// "merge multilayer wall as a single solid" toggle is on (issue #540): a part
/// is skipped when its parent's layered build-up is *sliceable* in the caller's
/// `material_layer_index` (the browser's per-content or prepass-injected one),
/// so the parent's merged-layer geometry is drawn instead of the parts. An
/// index with no sliceable buildup returns the empty set before any scan.
///
/// This layer/void **driver** composes the shared kernels
/// ([`propagate_voids_to_parts`], [`crate::MaterialLayerIndex::is_sliceable`])
/// next to them (#913 Phase 4 / §2.6) for the browser's `merge_layers` path. Its
/// scratch `void_index` stays EMPTY (only the part → parent map is wanted);
/// callers needing propagated voids call [`propagate_voids_to_parts`] themselves.
#[must_use]
pub fn compute_parts_to_skip_with_index<T>(
    content: &T,
    decoder: &mut EntityDecoder,
    material_layer_index: &crate::MaterialLayerIndex,
) -> rustc_hash::FxHashSet<u32>
where
    T: AsRef<[u8]> + ?Sized,
{
    if material_layer_index.sliceable_count() == 0 {
        return rustc_hash::FxHashSet::default();
    }
    let mut void_index_scratch: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    propagate_voids_to_parts(&mut void_index_scratch, content.as_ref(), decoder)
        .into_iter()
        .filter(|(_, parent_id)| material_layer_index.is_sliceable(*parent_id))
        .map(|(part_id, _)| part_id)
        .collect()
}
