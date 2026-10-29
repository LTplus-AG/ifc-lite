// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Resolve and emit the worker columns before the first geometry job.
use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;
use js_sys::Function;
use wasm_bindgen::prelude::*;

pub(super) fn emit_columns(
    api: &IfcAPI,
    on_event: &Function,
    content: &[u8],
    discovery: &super::prepass_discovery::ColumnsDiscovery,
    decoder: &mut EntityDecoder<'_>,
) -> Result<ifc_lite_processing::discovery::TypeGeometryPlan, JsValue> {
    let prepass_spans = &discovery.prepass_spans;
    let mapped_item_spans = &discovery.mapped_item_spans;
    let has_layer_set = discovery.has_layer_set;
    // (B2) Pre-pass columns — the three per-content structures each geometry
    // worker would otherwise rebuild with its OWN full-file walk on its first
    // batch (issue #957 orphan/instanced type geometry + #563 material-layer
    // slicing). Built ONCE here from spans this scan already collected, then
    // installed on every worker via `set{ReferencedRepmaps,InstantiatedTypeIds,
    // MaterialLayerIndex}`. Emitted BEFORE the first jobs chunk (below) and
    // workers apply messages FIFO, so the injected data is always in place
    // before any `processGeometryBatch` — the lazy per-worker build (the
    // byte-identical fallback) never fires on the streaming path.

    let type_plan = ifc_lite_processing::discovery::TypeGeometryPlan::from_spans(
        content,
        mapped_item_spans,
        &prepass_spans.defines_by_type,
        &[],
        decoder,
        ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
    );
    // #1623 Phase 3 don't-bake plan: the RepresentationMap ids an IfcMappedItem
    // instantiates >= 2 times, tallied from the SAME spans (no extra scan). The
    // batch path arms its router with these so a repeated single-solid mapped
    // source materializes once per batch and the rest ride as shard instances.
    let mapped_instance_plan = type_plan.browser_instance_sources();
    // Gate on `has_layer_set` to stay bit-identical to
    // `get_or_build_material_layer_index`, which ships an EMPTY index when the
    // file authors no layer set (its substring bail-out). from_spans reuses
    // the already-stashed IfcRelAssociatesMaterial spans — no extra walk.
    api.collect_pipeline_refusals(decoder);
    let material_layer_flat = if has_layer_set {
        ifc_lite_geometry::MaterialLayerIndex::from_spans(
            &prepass_spans.rel_associates_material,
            decoder,
        )
        .to_flat()
    } else {
        ifc_lite_geometry::MaterialLayerFlat::default()
    };

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
