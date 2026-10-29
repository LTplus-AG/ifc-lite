// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared record discovery; native metadata and geometry-job decoration remain consumers.
use crate::{prepass::PrepassSpans, scan::ScanClass};
use ifc_lite_core::{
    parser::{parse_ref, StepRecord},
    IfcType, StepListItems,
};
use rustc_hash::{FxHashMap, FxHashSet};

/// #957: type-product geometry (IfcXxxType + its RepresentationMaps) and the
/// set of RepresentationMaps already instantiated by an IfcMappedItem. After
/// the scan, RepresentationMaps NOT in the referenced set are rendered as
/// orphan type geometry (buildingSMART annex-E showcase files).
#[derive(Default)]
pub struct TypeScan {
    pub products: Vec<(u32, usize, usize, IfcType, Vec<u32>)>,
    pub referenced_representation_maps: FxHashSet<u32>,
    // #957 follow-up: type ids that an IfcRelDefinesByType instantiates (the type
    // has at least one occurrence). Such a type's geometry is already drawn through
    // its occurrences — directly or via an IfcMappedItem — so it must NOT also be
    // rendered as orphan type-only geometry. Real-world exporters (e.g. ArchiCAD
    // AC20) attach a RepresentationMap to nearly every door/window/furniture type
    // while the occurrence carries its own body, leaving the type map referenced by
    // no IfcMappedItem; without this gate every such type double-renders at its
    // MappingOrigin (duplicate boxes at the wrong position).
    pub instantiated_type_ids: FxHashSet<u32>,
}
/// The references in attribute `index`: every `#n` item of a list, or the one
/// reference the attribute is. An item that is not exactly `#digits` (`#+5`,
/// `#12abc`, an id past `u32::MAX`) is skipped, not guessed.
pub(crate) fn ref_items(record: Option<&StepRecord<'_>>, index: usize) -> Vec<u32> {
    let Some(token) = record.and_then(|record| record.attr(index)) else {
        return Vec::new();
    };
    match StepListItems::of_list(token) {
        Some(items) => items.filter_map(parse_ref).collect(),
        None => parse_ref(token).into_iter().collect(),
    }
}

/// Attribute `index` of a scanned record when it is exactly one reference.
#[inline(never)]
pub(crate) fn record_ref_at(bytes: &[u8], index: usize) -> Option<u32> {
    StepRecord::parse(bytes)?.ref_at(index)
}

/// The references in attribute `index` of a scanned record ([`ref_items`]).
#[inline(never)]
pub(crate) fn record_refs_at(bytes: &[u8], index: usize) -> Vec<u32> {
    ref_items(StepRecord::parse(bytes).as_ref(), index)
}

/// Scan-time state shared by native and future browser adapters.
#[derive(Default)]
#[non_exhaustive]
pub struct Discovery {
    pub prepass_spans: PrepassSpans,
    pub project_id: Option<u32>,
    pub site_entity_pos: Option<(usize, usize)>,
    pub building_entity_pos: Option<(usize, usize)>,
    pub mapped_item_plan: FxHashMap<u32, (u32, u32)>,
    pub types: TypeScan,
    instancing: bool,
}

impl Discovery {
    pub fn new(instancing: bool) -> Self {
        Self {
            instancing,
            ..Self::default()
        }
    }

    /// Browser callers use `observe_browser` to omit native-only type/mapping state.
    pub fn browser() -> Self {
        Self::default()
    }

    /// Observe one record in file order. Returns the type of a geometry job;
    /// callers retain the raw keyword when decorating metadata (#1910).
    #[inline(always)]
    pub fn observe(
        &mut self,
        content: &[u8],
        class: ScanClass,
        id: u32,
        type_name: &str,
        start: usize,
        end: usize,
    ) -> Option<IfcType> {
        self.observe_inner::<false>(content, class, id, type_name, start, end)
    }

    /// Observe a browser record without collecting native type/mapping state.
    #[inline(always)]
    pub fn observe_browser(
        &mut self,
        content: &[u8],
        class: ScanClass,
        id: u32,
        type_name: &str,
        start: usize,
        end: usize,
    ) -> Option<IfcType> {
        self.observe_inner::<true>(content, class, id, type_name, start, end)
    }

    #[inline(always)]
    fn observe_inner<const BROWSER: bool>(
        &mut self,
        content: &[u8],
        class: ScanClass,
        id: u32,
        type_name: &str,
        start: usize,
        end: usize,
    ) -> Option<IfcType> {
        if matches!(
            class,
            ScanClass::IndexedColourMap
                | ScanClass::StyledItem
                | ScanClass::MaterialDefinitionRepresentation
                | ScanClass::RelAssociatesMaterial
        ) {
            self.prepass_spans.stash_class(class, id, start, end);
            return None;
        }
        match class {
            ScanClass::RelVoidsElement | ScanClass::RelFillsElement
            | ScanClass::RelAggregates | ScanClass::RelDefinesByType => {
                self.prepass_spans.stash_class(class, id, start, end);
            }
            ScanClass::Project => {
                self.project_id.get_or_insert(id);
            }
            ScanClass::Site => {
                self.site_entity_pos.get_or_insert((start, end));
            }
            ScanClass::Building => {
                self.building_entity_pos.get_or_insert((start, end));
            }
            _ => {}
        }
        if ifc_lite_core::is_geometry_job(type_name, &content[start..end]) {
            Some(ifc_lite_core::ifc_type_from_keyword(type_name))
        } else {
            if !BROWSER {
                self.note_type_geometry(content, class, id, type_name, start, end);
            }
            None
        }
    }

    // #957: collect type-product geometry (IfcXxxType carrying its own
    // RepresentationMaps) and every IfcMappedItem's MappingSource, so after
    // the scan we can render the RepresentationMaps that NO occurrence
    // instantiates (orphan library/showcase geometry). The cheap suffix
    // pre-filter keeps the is_subtype_of check off the hot path for the
    // ~all-non-type majority of entities.
    #[inline(always)]
    fn note_type_geometry(
        &mut self,
        content: &[u8],
        class: ScanClass,
        id: u32,
        type_name: &str,
        start: usize,
        end: usize,
    ) {
        if class == ScanClass::MappedItem {
            if let Some(source_id) = record_ref_at(&content[start..end], 0) {
                self.types.referenced_representation_maps.insert(source_id);
                // #1623 Phase 2: tally occurrences per source + track the min-id
                // (deterministic template) occurrence. `id` is this IfcMappedItem's
                // express id (the router's `item.id` at mesh time).
                if self.instancing {
                    self.mapped_item_plan
                        .entry(source_id)
                        .and_modify(|(count, template)| {
                            *count += 1;
                            if id < *template {
                                *template = id;
                            }
                        })
                        .or_insert((1, id));
                }
            }
        } else if class == ScanClass::RelDefinesByType {
            // IfcRelDefinesByType.RelatingType is the last attribute (index 5);
            // record it so its type-only geometry is suppressed (it has occurrences).
            // (Its span also feeds the shared resolver's type-material fallback:
            // stashed with the other relationship spans above.)
            if let Some(type_id) = record_ref_at(&content[start..end], 5) {
                self.types.instantiated_type_ids.insert(type_id);
            }
        } else if let Some(type_ty) = ifc_lite_core::type_product_ifc_type(type_name) {
            // IfcTypeProduct.RepresentationMaps is attribute index 6.
            let rep_map_ids = record_refs_at(&content[start..end], 6);
            if !rep_map_ids.is_empty() {
                self.types.products.push((id, start, end, type_ty, rep_map_ids));
            }
        }
    }
}
