// SPDX-License-Identifier: MPL-2.0
//! Per-job browser admission, type plan and canonical owned production.
use super::batch_output::ElementMeshOutput;
use super::batch_prepare::BatchSetup;
use super::style_finishes::BatchFinishes;
use crate::api::styling::resolve_element_color;
use crate::api::IfcAPI;
use ifc_lite_processing::element::{produce_element_meshes_owned, ElementJobKind, ElementMeshJob};
use rustc_hash::FxHashMap;

#[derive(Default)]
pub(super) struct BatchState {
    pub outputs: Vec<ElementMeshOutput>,
    pub csg_failures: FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
    pub elements: u64,
    pub backstop: u64,
    pub refused: u64,
    pub occurrences: Vec<ifc_lite_processing::RawInstanceOccurrence>,
}
impl IfcAPI {
    pub(super) fn produce_batch_element(
        &self,
        content: &[u8],
        chunk: &[u32],
        setup: &mut BatchSetup<'_>,
        batch_finishes: &mut BatchFinishes<'_>,
        state: &mut BatchState,
    ) {
        let geometry_styles = &setup.style_maps.0;
        let id = chunk[0];
        let start = chunk[1] as usize;
        let end = chunk[2] as usize;

        if setup.parts_to_skip.contains(&id) {
            return;
        }

        let span = ifc_lite_processing::execution::JobSpan { id, start, end };
        let Ok(entity) = ifc_lite_processing::execution::decode_job(
            &mut setup.decoder,
            span,
            ifc_lite_processing::execution::SchedulerPolicy::PerBatch,
        ) else {
            self.record_input_refusals(&setup.decoder, false);
            return;
        };
        // Not every dropped keyword reaches production: the four arms with
        // `has_geometry: false` are refused by `has_geometry_by_name` in all
        // three element producers. #3187 traces the type-geometry gate that
        // would make THREE of the four eligible -- eligible, not certain.
        let ifc_type = ifc_lite_processing::execution::job_type(&entity, content, span, None);

        // The wire's slot 6 is RepresentationMaps on type products and
        // Representation on occurrences. Use the named index without a typed
        // entity assertion: source-keyword recovery also supports legacy types.
        let is_type_product = ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct);
        let representation_slot = if is_type_product {
            ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index()
        } else {
            ifc_lite_core::slot::IfcProduct::REPRESENTATION.index()
        };
        let element_color = if !geometry_styles.is_empty()
            && entity
                .get(representation_slot)
                .map(|a| !a.is_null())
                .unwrap_or(false)
        {
            resolve_element_color(&entity, geometry_styles, &mut setup.decoder)
        } else {
            None
        };

        let kind = if is_type_product {
            let rep_map_ids = ifc_lite_processing::discovery::record_refs_at(
                content.get(start..end).unwrap_or_default(),
                ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index(),
            );
            if rep_map_ids.is_empty() {
                self.record_input_refusals(&setup.decoder, setup.router.length_unit_refused());
                return;
            }
            let type_plan = self.get_or_build_type_geometry_plan(content, &mut setup.decoder);
            let rep_maps = type_plan.maps_for(id, &rep_map_ids);
            if rep_maps.is_empty() {
                self.record_input_refusals(&setup.decoder, setup.router.length_unit_refused());
                return;
            }
            ElementJobKind::TypeProduct { rep_maps }
        } else {
            ElementJobKind::Product
        };

        #[cfg(test)]
        super::batch::parity::record_job(id, &kind);
        let produced = produce_element_meshes_owned(
            &ElementMeshJob {
                id,
                ifc_type,
                entity: &entity,
                kind,
                element_color,
                metadata: None,
            },
            &setup.ctx,
            &setup.opts,
            &mut setup.decoder,
            &setup.router,
        );
        let Ok(produced) = produced else {
            self.record_input_refusals(&setup.decoder, setup.router.length_unit_refused());
            state.refused += 1;
            return;
        };

        for (product_id, fails) in produced.csg_failures {
            state
                .csg_failures
                .entry(product_id)
                .or_default()
                .extend(fails);
        }
        state.elements += 1;
        state.backstop += produced.degenerate_triangles_dropped;
        if !produced.instance_occurrences.is_empty() {
            state.occurrences.extend(produced.instance_occurrences);
        }
        state.outputs.push(ElementMeshOutput {
            id,
            finishes: batch_finishes.for_meshes(&produced.meshes, &mut setup.decoder),
            meshes: produced.meshes,
            geometry_hash: produced.geometry_hash,
            geometry_aabb: produced.geometry_aabb,
            geometry_volume: produced.geometry_volume,
            geometry_closure_bits: produced.geometry_closure.map_or(0, |c| c.bits()),
        });
        // Finish resolution can re-decode refused items too. Drain the whole
        // element scope only after the join, before the next job starts.
        self.record_input_refusals(&setup.decoder, setup.router.length_unit_refused());
    }
}
