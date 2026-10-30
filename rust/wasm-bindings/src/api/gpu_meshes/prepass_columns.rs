// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Resolve and emit the worker columns before the first geometry job.
use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;
use js_sys::Function;
use wasm_bindgen::prelude::*;

/// The per-content columns each geometry batch would otherwise rebuild with its
/// own full-file walk (#957 type-geometry sets, #563 material-layer index),
/// built ONCE from spans the pre-pass scan already collected. The streaming
/// pre-pass flattens them onto the worker wire ([`emit_columns`]); the once
/// path installs them on its own `IfcAPI` ([`IfcAPI::install_prepass_columns`]).
pub(super) struct PrepassColumns {
    pub type_plan: ifc_lite_processing::discovery::TypeGeometryPlan,
    pub material_layers: ifc_lite_geometry::MaterialLayerIndex,
}

impl PrepassColumns {
    /// `has_layer_set` is the caller's layer-set gate; an ungated file ships an
    /// EMPTY index, as `get_or_build_material_layer_index` does.
    pub(super) fn build(
        content: &[u8],
        prepass_spans: &ifc_lite_processing::prepass::PrepassSpans,
        mapped_item_spans: &[(u32, usize, usize)],
        has_layer_set: bool,
        decoder: &mut EntityDecoder<'_>,
    ) -> Self {
        let type_plan = ifc_lite_processing::discovery::TypeGeometryPlan::from_spans(
            content,
            mapped_item_spans,
            &prepass_spans.defines_by_type,
            &[],
            decoder,
            ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
        );
        // from_spans reuses the already-stashed IfcRelAssociatesMaterial
        // spans and equals `MaterialLayerIndex::from_content` — no extra walk.
        let material_layers = if has_layer_set {
            ifc_lite_geometry::MaterialLayerIndex::from_spans(
                &prepass_spans.rel_associates_material,
                decoder,
            )
        } else {
            ifc_lite_geometry::MaterialLayerIndex::new()
        };
        Self { type_plan, material_layers }
    }
}

impl IfcAPI {
    /// Install columns built by this `IfcAPI`'s own pre-pass, the same values
    /// the worker setters install, so its batches never run the lazy fallbacks.
    pub(super) fn install_prepass_columns(&self, columns: PrepassColumns) {
        let PrepassColumns { type_plan, material_layers } = columns;
        for (slot, set) in [
            (&self.content.cached_referenced_repmaps, type_plan.referenced_representation_maps),
            (&self.content.cached_instantiated_type_ids, type_plan.instantiated_type_ids),
        ] {
            *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(std::sync::Arc::new(set));
        }
        *self.content.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(std::sync::Arc::new(material_layers));
    }
}

pub(super) fn emit_columns(
    api: &IfcAPI,
    on_event: &Function,
    content: &[u8],
    discovery: &super::prepass_discovery::ColumnsDiscovery,
    decoder: &mut EntityDecoder<'_>,
) -> Result<ifc_lite_processing::discovery::TypeGeometryPlan, JsValue> {
    // (B2) Pre-pass columns, installed on every worker via
    // `set{ReferencedRepmaps,InstantiatedTypeIds,MaterialLayerIndex}`. Emitted
    // BEFORE the first jobs chunk (below) and workers apply messages FIFO, so
    // the injected data is always in place before any `processGeometryBatch` —
    // the lazy per-worker build (the byte-identical fallback) never fires on
    // the streaming path. Gate on the scanned layer-set class: no layer set
    // ships an EMPTY index, like the lazy build's substring bail-out.
    let PrepassColumns { type_plan, material_layers } = PrepassColumns::build(
        content,
        &discovery.prepass_spans,
        &discovery.mapped_item_spans,
        discovery.has_layer_set,
        decoder,
    );
    api.collect_pipeline_refusals(decoder);
    // #1623 Phase 3 don't-bake plan: the RepresentationMap ids an IfcMappedItem
    // instantiates >= 2 times, tallied from the SAME spans (no extra scan). The
    // batch path arms its router with these so a repeated single-solid mapped
    // source materializes once per batch and the rest ride as shard instances.
    let mapped_instance_plan = type_plan.browser_instance_sources();
    let material_layer_flat = material_layers.to_flat();

    let repmaps_arr: Vec<u32> = type_plan
        .referenced_representation_maps
        .iter()
        .copied()
        .collect();
    let type_ids_arr: Vec<u32> = type_plan.instantiated_type_ids.iter().copied().collect();
    let columns_event = js_sys::Object::new();
    crate::api::set_js_prop(&columns_event, "type", &"prepass-columns".into());
    crate::api::set_js_prop(
        &columns_event,
        "referencedRepmaps",
        &js_sys::Uint32Array::from(repmaps_arr.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "instantiatedTypeIds",
        &js_sys::Uint32Array::from(type_ids_arr.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mappedInstancePlan",
        &js_sys::Uint32Array::from(mapped_instance_plan.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliElementIds",
        &js_sys::Uint32Array::from(material_layer_flat.element_ids.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliAxis",
        &js_sys::Uint32Array::from(material_layer_flat.axis.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliLayerCounts",
        &js_sys::Uint32Array::from(material_layer_flat.layer_counts.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliDirectionSense",
        &js_sys::Float64Array::from(&material_layer_flat.direction_sense[..]),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliOffset",
        &js_sys::Float64Array::from(&material_layer_flat.offset[..]),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliLayerMaterialIds",
        &js_sys::Uint32Array::from(material_layer_flat.layer_material_ids.as_slice()),
    );
    crate::api::set_js_prop(
        &columns_event,
        "mliLayerThicknesses",
        &js_sys::Float64Array::from(&material_layer_flat.layer_thicknesses[..]),
    );
    on_event.call1(&JsValue::NULL, &columns_event.into())?;

    Ok(type_plan)
}
