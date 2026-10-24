// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native pipeline's entity scan: one walk over the file that builds the
//! entity index inline, schedules the geometry jobs and stashes every span a
//! later phase resolves.

use super::color_layer::collect_presentation_layer_assignments;
use super::entity_index::IndexBuilder;
use super::quick_collector::QuickCollector;
use super::quick_metadata::{record_ref_at, record_refs_at};
use super::{EntityJob, ProcessingRequest};
use crate::scan::ScanClass;
use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;
use crate::plan::{TypeGeometryCandidate, TypeGeometryPlan};

impl EntityJob {
    /// A product job: no appearance or metadata yet, the type's default colour.
    pub(super) fn new(id: u32, ifc_type: IfcType, start: usize, end: usize) -> Self {
        let element_color = crate::style::default_color_for_type(ifc_type.clone()).to_array();
        Self {
            id,
            ifc_type,
            start,
            end,
            product_definition_shape_id: None,
            element_color,
            global_id: None,
            name: None,
            presentation_layer: None,
            space_zone_properties: None,
            representation_map_id: None,
        }
    }

    /// Render this type product's `IfcRepresentationMap` directly (#957).
    fn for_type_map(mut self, representation_map_id: u32) -> Self {
        self.representation_map_id = Some(representation_map_id);
        self
    }
}

/// What the scan hands to the phases after it.
pub(super) struct ScanOutput {
    pub(super) entity_jobs: Vec<EntityJob>,
    pub(super) prepass_spans: crate::prepass::PrepassSpans,
    pub(super) project_id: Option<u32>,
    pub(super) presentation_layer_by_assigned_id: FxHashMap<u32, String>,
    pub(super) rel_defines_spans: Vec<(usize, usize)>,
    pub(super) georeferencing_candidates: Vec<(u32, IfcType)>,
    /// #1623 don't-bake plan: representation map => (occurrences, min mapped-item id).
    pub(super) mapped_item_plan: FxHashMap<u32, (u32, u32)>,
    pub(super) quick: Option<QuickCollector>,
    pub(super) total_entities: usize,
    pub(super) site_entity_pos: Option<(usize, usize)>,
    pub(super) building_entity_pos: Option<(usize, usize)>,
}

impl TypeGeometryPlan {
    /// #957: synthesize render jobs for orphan type-product geometry — a
    /// RepresentationMap on an IfcXxxType that no IfcMappedItem instantiates.
    /// Normally-instanced typed products keep their geometry on the occurrence
    /// (whose IfcMappedItem references the map), so those maps are in
    /// `referenced_representation_maps` and skipped here — no double render.
    /// buildingSMART annex-E "tessellated shape with style" files declare the
    /// geometry only on the type, so without this they render nothing (#957).
    fn append_orphan_jobs(&self, entity_jobs: &mut Vec<EntityJob>) {
        for candidate in self.candidates() {
            let TypeGeometryCandidate { id: type_id, start, end, ifc_type, maps: rep_map_ids } = candidate;
            // The orphan/instanced decision is canonical in
            // `element::plan_type_geometry`; the native pipeline suppresses
            // instanced types entirely (an export must never duplicate geometry),
            // so every planned map here renders as an orphan (class 1).
            for (rep_map_id, _class) in crate::element::plan_type_geometry(
                rep_map_ids,
                self.referenced(),
                self.is_instantiated(*type_id),
                crate::element::TypeGeometryMode::SuppressInstanced,
            ) {
                let job = EntityJob::new(*type_id, ifc_type.clone(), *start, *end);
                entity_jobs.push(job.for_type_map(rep_map_id));
            }
        }
    }
}

/// The scan loop's state: what it reads, what it fills, and the inline index.
struct Scan<'a, 'd> {
    content: &'a [u8],
    req: &'a ProcessingRequest,
    decoder: &'a mut EntityDecoder<'d>,
    inline_index: &'a mut IndexBuilder,
    building_index: bool,
    out: ScanOutput,
    types: TypeGeometryPlan,
}

/// Walk `content` once. `building_index` says whether `inline_index` is being
/// filled (no index was injected); `decoder` only needs local bytes here.
pub(super) fn scan_entities(
    content: &[u8],
    req: &ProcessingRequest,
    decoder: &mut EntityDecoder,
    inline_index: &mut IndexBuilder,
    building_index: bool,
) -> ScanOutput {
    let out = ScanOutput {
        entity_jobs: Vec::with_capacity(2000),
        // Styled items / indexed colour maps / material chain / voids / fills /
        // aggregates are span-stashed during the scan and resolved afterwards by
        // the SHARED resolver (`crate::prepass::resolve_prepass`) — the exact code
        // the browser prepasses run, so the #858/#913-class resolution drift
        // cannot recur.
        prepass_spans: crate::prepass::PrepassSpans::default(),
        project_id: None,
        presentation_layer_by_assigned_id: FxHashMap::default(),
        rel_defines_spans: Vec::new(),
        georeferencing_candidates: Vec::new(),
        // #1623 Phase 2 don't-bake plan (built only when `enable_instancing`):
        // `IfcRepresentationMap` id ⇒ (occurrence count, min IfcMappedItem express id).
        // The min-id occurrence is the deterministic template that materializes; the
        // rest instance against it. Filtered to count >= 2 after the scan.
        mapped_item_plan: FxHashMap::default(),
        quick: req.features.quick_metadata_bootstrap.then(QuickCollector::new),
        total_entities: 0,
        site_entity_pos: None,
        building_entity_pos: None,
    };
    let mut scan = Scan {
        content,
        req,
        decoder,
        inline_index,
        building_index,
        out,
        types: TypeGeometryPlan::default(),
    };

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        scan.visit(id, type_name, start, end);
    }
    // The whole-file scan: refused ids (#3395) + a malformed stop (#3695).
    ifc_lite_core::report_scan_diagnostics(scanner.skipped_oversized_ids(), scanner.malformed_record_start().is_some());

    scan.types.append_orphan_jobs(&mut scan.out.entity_jobs);
    scan.out.mapped_item_plan = scan.types.into_mapped_instances();
    scan.out
}

impl Scan<'_, '_> {
    /// One record: index it, feed the quick collector, then either stash its
    /// span for a later phase or schedule it.
    #[inline(always)]
    fn visit(&mut self, id: u32, type_name: &str, start: usize, end: usize) {
        self.out.total_entities += 1;
        if let Some(ifc_type) = crate::georeferencing::georeferencing_candidate_type(type_name) {
            self.out.georeferencing_candidates.push((id, ifc_type));
        }
        if self.building_index {
            self.inline_index.insert(id, (start, end));
        }
        if let Some(quick) = self.out.quick.as_mut() {
            quick.observe(self.content, id, type_name, start, end);
        }
        let class = ScanClass::classify(type_name);
        if self.stash_span(class, id, start, end) {
            return;
        }
        self.schedule(class, id, type_name, start, end);
    }

    /// Span-stashing records. `true` when the record is fully handled and must
    /// not reach the job scheduling below.
    #[inline(always)]
    fn stash_span(&mut self, class: ScanClass, id: u32, start: usize, end: usize) -> bool {
        match class {
            // Span-stashed for the shared post-scan resolver (#663, #858). Styled
            // items are classified there: orphan (material appearance, #407 —
            // always resolved up front) vs geometry-attached (deferred in
            // fast_first_batch mode, #913 §2c).
            ScanClass::IndexedColourMap
            | ScanClass::StyledItem
            | ScanClass::MaterialDefinitionRepresentation
            | ScanClass::RelAssociatesMaterial => {
                self.out.prepass_spans.stash_class(class, id, start, end);
                true
            }
            ScanClass::PresentationLayerAssignment => {
                if self.req.features.presentation_layers {
                    if let Ok(layer_assignment) = self.decoder.decode_at(start, end) {
                        collect_presentation_layer_assignments(
                            &mut self.out.presentation_layer_by_assigned_id,
                            &layer_assignment,
                        );
                    }
                }
                true
            }
            // Decoded lazily in the lookup phase, and only when referenced by a
            // space/zone (its sole consumer). The inline index holds the span.
            // Individual property values are resolved lazily by id in the same
            // phase (only those a referenced space/zone property set lists).
            ScanClass::PropertySet | ScanClass::Property => true,
            ScanClass::RelDefinesByProperties => {
                // Space/zone property resolution is demand-driven (see the lookup
                // phase and `resolve_space_zone_properties_lazy`). The scan only
                // stashes these spans; property sets and atoms are decoded later,
                // and only for the handful a space/zone actually references —
                // skipping the eager decode of ~25% of a model's entities that was
                // the dominant single-threaded cold-load cost on parse-bound models.
                if self.req.features.properties {
                    self.out.rel_defines_spans.push((start, end));
                }
                true
            }
            // Relationship spans the resolver reads (aggregates independent of
            // quick-metadata mode: they push voids down to aggregated parts when
            // the host has no body of its own, IfcWallElementedCase, #845), and
            // the first project / site / building. None ends the record's
            // processing.
            ScanClass::RelVoidsElement
            | ScanClass::RelFillsElement
            | ScanClass::RelAggregates
            | ScanClass::RelDefinesByType => {
                self.out.prepass_spans.stash_class(class, id, start, end);
                false
            }
            ScanClass::Project => {
                self.out.project_id.get_or_insert(id);
                false
            }
            ScanClass::Site => {
                self.out.site_entity_pos.get_or_insert((start, end));
                false
            }
            ScanClass::Building => {
                self.out.building_entity_pos.get_or_insert((start, end));
                false
            }
            _ => false,
        }
    }

    /// Schedule a geometry job, or record what the type-geometry and
    /// instancing plans need from this record.
    #[inline(always)]
    fn schedule(&mut self, class: ScanClass, id: u32, type_name: &str, start: usize, end: usize) {
        let (has_geometry, representationless_spatial) =
            ifc_lite_core::geometry_flags_by_name(type_name);
        if has_geometry {
            // Legacy-aware so a remapped entity (IfcProxy, IfcSolidStratum, …)
            // labels its node with the real base type, not "Unknown", and matches
            // the attribute pass's row type (#1496).
            let ifc_type = ifc_lite_core::ifc_type_from_keyword(type_name);
            if let Some(quick) = self.out.quick.as_mut() {
                quick.note_element(id, type_name);
            }
            self.out.entity_jobs.push(EntityJob::new(id, ifc_type, start, end));
        } else if representationless_spatial
            && ifc_lite_core::nth_attribute_is_present(&self.content[start..end], 6)
        {
            // #1910: `has_geometry_by_name` excludes spatial containers like
            // `IfcBuilding` because in virtually every real file they are
            // pure hierarchy nodes with a null Representation. A DGM/terrain
            // export that attaches its `IfcShellBasedSurfaceModel` directly
            // to `IfcBuilding` (no `IfcBuildingElement` children at all) is
            // the exceptional counter-example: its geometry must still be
            // scheduled for meshing, or the file loads with correct metadata
            // but renders nothing. Deliberately skips the
            // `note_element` call above — the spatial tree
            // already carries this entity as a node, so an
            // extra "element" summary row would duplicate it in the UI tree.
            let ifc_type = ifc_lite_core::ifc_type_from_keyword(type_name);
            self.out.entity_jobs.push(EntityJob::new(id, ifc_type, start, end));
        } else {
            self.note_type_geometry(class, id, type_name, start, end);
        }
    }

    // #957: collect type-product geometry (IfcXxxType carrying its own
    // RepresentationMaps) and every IfcMappedItem's MappingSource, so after
    // the scan we can render the RepresentationMaps that NO occurrence
    // instantiates (orphan library/showcase geometry). The cheap suffix
    // pre-filter keeps the is_subtype_of check off the hot path for the
    // ~all-non-type majority of entities.
    #[inline(always)]
    fn note_type_geometry(&mut self, class: ScanClass, id: u32, type_name: &str, start: usize, end: usize) {
        if class == ScanClass::MappedItem {
            if let Some(source_id) = record_ref_at(&self.content[start..end], 0) {
                self.types.observe_mapped(id, source_id, self.req.instancing);
            }
        } else if class == ScanClass::RelDefinesByType {
            // IfcRelDefinesByType.RelatingType is the last attribute (index 5);
            // record it so its type-only geometry is suppressed (it has occurrences).
            // (Its span also feeds the shared resolver's type-material fallback:
            // stashed with the other relationship spans above.)
            if let Some(type_id) = record_ref_at(&self.content[start..end], 5) {
                self.types.observe_instantiated_type(type_id);
            }
        } else if let Some(type_ty) = ifc_lite_core::type_product_ifc_type(type_name) {
            // IfcTypeProduct.RepresentationMaps is attribute index 6.
            let rep_map_ids = record_refs_at(&self.content[start..end], 6);
            if !rep_map_ids.is_empty() {
                self.types.observe_candidate(id, start, end, type_ty, rep_map_ids);
            }
        }
    }
}
