// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared record discovery; native metadata and geometry-job decoration remain consumers.
use crate::element::{plan_type_geometry, TypeGeometryMode};
use crate::{prepass::PrepassSpans, scan::ScanClass};
use ifc_lite_core::{
    parser::{parse_ref, StepRecord},
    IfcType, StepListItems,
};
use rustc_hash::{FxHashMap, FxHashSet};

/// One file's type-geometry decisions. The mode is explicit because exports
/// suppress instantiated types while the viewer tags them for its Types view.
pub type PlannedTypeProduct = (u32, usize, usize, IfcType, Vec<(u32, u8)>);
pub struct TypeGeometryPlan {
    pub mode: TypeGeometryMode,
    pub referenced_representation_maps: FxHashSet<u32>,
    pub instantiated_type_ids: FxHashSet<u32>,
    pub mapped_item_plan: FxHashMap<u32, (u32, u32)>,
    pub products: Vec<PlannedTypeProduct>,
}

impl TypeGeometryPlan {
    pub fn from_file(content: &[u8], decoder: &mut ifc_lite_core::EntityDecoder, mode: TypeGeometryMode) -> Self {
        Self::from_file_missing(content, decoder, true, true, mode)
    }

    pub fn from_file_missing(
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
        need_referenced: bool,
        need_instantiated: bool,
        mode: TypeGeometryMode,
    ) -> Self {
        let mut mapped = Vec::new();
        let mut defines = Vec::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if need_referenced && ifc_lite_core::keyword_eq(name, "IFCMAPPEDITEM") {
                mapped.push((id, start, end));
            } else if need_instantiated && ifc_lite_core::keyword_eq(name, "IFCRELDEFINESBYTYPE") {
                defines.push((id, start, end));
            }
        }
        Self::from_spans(content, &mapped, &defines, &[], decoder, mode)
    }

    pub fn from_sets(
        referenced_representation_maps: FxHashSet<u32>,
        instantiated_type_ids: FxHashSet<u32>,
        mode: TypeGeometryMode,
    ) -> Self {
        Self {
            mode,
            referenced_representation_maps,
            instantiated_type_ids,
            mapped_item_plan: FxHashMap::default(),
            products: Vec::new(),
        }
    }

    pub fn maps_for(&self, id: u32, maps: &[u32]) -> Vec<(u32, u8)> {
        plan_type_geometry(
            maps,
            &self.referenced_representation_maps,
            self.instantiated_type_ids.contains(&id),
            self.mode,
        )
    }

    pub fn from_scan(types: TypeScan, mapped_item_plan: FxHashMap<u32, (u32, u32)>, mode: TypeGeometryMode) -> Self {
        let TypeScan {
            products,
            referenced_representation_maps,
            instantiated_type_ids,
        } = types;
        let products = products
            .into_iter()
            .map(|(id, start, end, ty, maps)| {
                let maps = plan_type_geometry(
                    &maps,
                    &referenced_representation_maps,
                    instantiated_type_ids.contains(&id),
                    mode,
                );
                (id, start, end, ty, maps)
            })
            .collect();
        Self {
            mode,
            referenced_representation_maps,
            instantiated_type_ids,
            mapped_item_plan,
            products,
        }
    }

    /// Browser spans are decoded with the full decoder. A type record rejected
    /// there is intentionally omitted, even if the scan-time parser accepts it.
    pub fn from_spans(
        content: &[u8],
        mapped: &[(u32, usize, usize)],
        defines: &[(u32, usize, usize)],
        candidates: &[(u32, usize, usize, IfcType)],
        decoder: &mut ifc_lite_core::EntityDecoder,
        mode: TypeGeometryMode,
    ) -> Self {
        let mut referenced_representation_maps = FxHashSet::default();
        let mut instantiated_type_ids = FxHashSet::default();
        let mut mapped_item_plan: FxHashMap<u32, (u32, u32)> = FxHashMap::default();
        for &(id, start, end) in mapped {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(source) = entity.get_ref(ifc_lite_core::slot::IfcMappedItem::MAPPING_SOURCE.index()) {
                    referenced_representation_maps.insert(source);
                    mapped_item_plan
                        .entry(source)
                        .and_modify(|(count, min)| {
                            *count += 1;
                            *min = (*min).min(id);
                        })
                        .or_insert((1, id));
                }
            }
        }
        for &(id, start, end) in defines {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(ty) = entity.get_ref(ifc_lite_core::slot::IfcRelDefinesByType::RELATING_TYPE.index()) {
                    instantiated_type_ids.insert(ty);
                }
            }
        }
        let mut plan = Self {
            mode,
            referenced_representation_maps,
            instantiated_type_ids,
            mapped_item_plan,
            products: Vec::new(),
        };
        plan.decode_products(content, candidates, decoder);
        plan
    }

    pub fn decode_products(
        &mut self,
        content: &[u8],
        candidates: &[(u32, usize, usize, IfcType)],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) {
        for (id, start, end, ty) in candidates {
            if decoder.decode_at_with_id(*id, *start, *end).is_err() {
                continue;
            }
            let maps = record_refs_at(
                content.get(*start..*end).unwrap_or_default(),
                ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index(),
            );
            if maps.is_empty() {
                continue;
            }
            let maps = self.maps_for(*id, &maps);
            self.products.push((*id, *start, *end, ty.clone(), maps));
        }
    }

    pub fn jobs(&self) -> Vec<(u32, usize, usize, IfcType)> {
        self.products
            .iter()
            .filter(|(_, _, _, _, maps)| !maps.is_empty())
            .map(|(id, start, end, ty, _)| (*id, *start, *end, ty.clone()))
            .collect()
    }

    pub fn browser_instance_sources(&self) -> Vec<u32> {
        let mut ids: Vec<_> = self
            .mapped_item_plan
            .iter()
            .filter(|(_, (count, _))| *count >= 2)
            .map(|(&id, _)| id)
            .collect();
        ids.sort_unstable();
        ids
    }
}

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
pub fn record_refs_at(bytes: &[u8], index: usize) -> Vec<u32> {
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
