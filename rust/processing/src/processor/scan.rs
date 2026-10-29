// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native pipeline's entity scan: one walk over the file that builds the
//! entity index inline, schedules the geometry jobs and stashes every span a
//! later phase resolves.

use super::color_layer::collect_presentation_layer_assignments;
use super::entity_index::IndexBuilder;
use super::quick_collector::QuickCollector;
use super::{EntityJob, ProcessingRequest};
use crate::scan::ScanClass;
use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;

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

/// The scan loop's state: what it reads, what it fills, and the inline index.
struct Scan<'a, 'd> {
    content: &'a [u8],
    req: &'a ProcessingRequest,
    decoder: &'a mut EntityDecoder<'d>,
    inline_index: &'a mut IndexBuilder,
    building_index: bool,
    out: ScanOutput,
    discovery: crate::discovery::Discovery,
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
        discovery: crate::discovery::Discovery::new(req.instancing),
    };

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        scan.visit(id, type_name, start, end);
    }
    // The whole-file scan: refused ids (#3395) + a malformed stop (#3695).
    ifc_lite_core::report_scan_diagnostics(scanner.skipped_oversized_ids(), scanner.malformed_record_start().is_some());

    let discovery = scan.discovery;
    for (id, start, end, ty, maps) in discovery.types.products {
        for (map, _) in crate::element::plan_type_geometry(
            &maps,
            &discovery.types.referenced_representation_maps,
            discovery.types.instantiated_type_ids.contains(&id),
            crate::element::TypeGeometryMode::SuppressInstanced,
        ) {
            scan.out
                .entity_jobs
                .push(EntityJob::new(id, ty.clone(), start, end).for_type_map(map));
        }
    }
    scan.out.prepass_spans = discovery.prepass_spans;
    scan.out.project_id = discovery.project_id;
    scan.out.site_entity_pos = discovery.site_entity_pos;
    scan.out.building_entity_pos = discovery.building_entity_pos;
    scan.out.mapped_item_plan = discovery.mapped_item_plan;
    #[cfg(feature = "parity-test-support")]
    crate::parity_test_support::record(scan.out.entity_jobs.iter().map(|j| {
        (
            j.id,
            j.representation_map_id,
            u8::from(j.representation_map_id.is_some()),
        )
    }));
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
        if self.stash_span(class, start, end) {
            return;
        }
        if let Some(ifc_type) = self.discovery.observe(self.content, class, id, type_name, start, end) {
            // Spatial exception jobs already have a hierarchy row (#1910).
            if let Some(quick) = self.out.quick.as_mut() {
                if !ifc_lite_core::is_representationless_spatial_container_type(ifc_type.clone()) {
                    quick.note_element(id, type_name);
                }
            }
            self.out.entity_jobs.push(EntityJob::new(id, ifc_type, start, end));
        }
    }

    /// Span-stashing records. `true` when the record is fully handled and must
    /// not reach the job scheduling below.
    #[inline(always)]
    fn stash_span(&mut self, class: ScanClass, start: usize, end: usize) -> bool {
        match class {
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
            _ => false,
        }
    }
}
