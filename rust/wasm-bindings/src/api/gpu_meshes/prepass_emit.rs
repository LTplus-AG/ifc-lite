// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Post-scan event order: entity-index, styles, columns, first wave, affinity,
//! type-library tail. Complete is emitted by the sequencer after diagnostics.
use super::prepass_affinity::fold_u128_to_u32;
use super::prepass_events::emit_jobs_chunk;
use super::prepass_scan::ScannedPrepass;
use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;
use js_sys::Function;
use wasm_bindgen::prelude::*;

pub(super) fn emit_scanned(
    api: &IfcAPI,
    content: &[u8],
    on_event: &Function,
    chunk_size: usize,
    skip_type_geometry: bool,
    scan: ScannedPrepass,
) -> Result<u32, JsValue> {
    let ScannedPrepass {
        index: entity_index_arc,
        mut discovery,
        plane_angle_to_radians,
        oversized_id_count,
        malformed_record_found,
        external_styles,
    } = scan;
    let buffered_jobs = &discovery.buffered_jobs;
    let mut total_jobs = discovery.total_jobs;
    let have_prebuilt = external_styles;
    {
        let mut slot = api
            .content
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(entity_index_arc.clone());
    }
    let index_for_export = entity_index_arc.clone();

    if !have_prebuilt {
        let ids_arr = js_sys::Uint32Array::from(index_for_export.ids());
        let starts_arr = js_sys::Uint32Array::from(index_for_export.starts());
        let lengths_arr = js_sys::Uint32Array::from(index_for_export.lengths());
        let index_event = js_sys::Object::new();
        crate::api::set_js_prop(&index_event, "type", &"entity-index".into());
        crate::api::set_js_prop(&index_event, "ids", &ids_arr);
        crate::api::set_js_prop(&index_event, "starts", &starts_arr);
        crate::api::set_js_prop(&index_event, "lengths", &lengths_arr);
        crate::api::set_js_prop(
            &index_event,
            "oversizedIdCount",
            &(oversized_id_count as f64).into(),
        ); // #3395: the parser worker sees only these columns
        crate::api::set_js_prop(
            &index_event,
            "malformedRecordFound",
            &malformed_record_found.into(),
        ); // #3695
        on_event.call1(&JsValue::NULL, &index_event.into())?;
    }

    let mut decoder = EntityDecoder::with_arc_columnar_index(content, entity_index_arc.clone())
        .with_strict_reals(); // #7678
    decoder.seed_unit_scales(1.0, plane_angle_to_radians);
    if !external_styles {
        let resolved = ifc_lite_processing::prepass::resolve_prepass(
            &discovery.prepass_spans,
            &mut decoder,
            ifc_lite_processing::prepass::ResolveOptions {
                collect_indexed_colour_full: false,
                defer_attached_styles: false,
            },
        );
        let geometry_finishes = ifc_lite_processing::prepass::resolve_geometry_finishes(
            &discovery.prepass_spans.styled_items,
            &mut decoder,
        );
        let styles_event =
            super::prepass_sharded::styles_payload(&resolved, &geometry_finishes, &mut decoder);
        crate::api::set_js_prop(&styles_event, "type", &"styles".into());
        on_event.call1(&JsValue::NULL, &styles_event.into())?;
    }

    let want_types = !skip_type_geometry
        && ifc_lite_core::find_keyword(content, b"IFCREPRESENTATIONMAP").is_some();
    let mut type_plan =
        super::prepass_columns::emit_columns(api, on_event, content, &discovery, &mut decoder)?;
    const FIRST_WAVE_JOBS: usize = 1024;
    let first_n = buffered_jobs.len().min(FIRST_WAVE_JOBS);
    if first_n > 0 {
        let first_aff: Vec<u32> = buffered_jobs[..first_n]
            .iter()
            .map(|&(id, ..)| id)
            .collect();
        emit_jobs_chunk(on_event, &buffered_jobs[..first_n], &first_aff)?;
    }

    {
        let mut akey_decoder =
            EntityDecoder::with_arc_columnar_index(content, entity_index_arc.clone());
        let akey_router = GeometryRouter::new(); // not drained: meshes nothing (issue_3821_auxiliary_routers_mesh_nothing.rs)
        let rest = &buffered_jobs[first_n..];
        super::affinity_chunks::emit_affinity_chunks(
            rest,
            chunk_size,
            |&(id, _s, _e, _)| match akey_decoder.decode_by_id(id) {
                Ok(ent) => akey_router
                    .geometry_routing_key(&ent, &mut akey_decoder)
                    .map(fold_u128_to_u32)
                    .unwrap_or(id),
                Err(_) => id,
            },
            |jobs_chunk, affinity| emit_jobs_chunk(on_event, jobs_chunk, affinity),
        )?;
    }

    // Release occurrence payloads before the type-library tail, as before.
    discovery.buffered_jobs.clear();

    if want_types {
        type_plan.decode_products(content, &discovery.type_candidate_spans, &mut decoder);
        let type_jobs = type_plan.jobs();
        if !type_jobs.is_empty() {
            total_jobs += type_jobs.len() as u32;
            let type_affinity: Vec<u32> = type_jobs.iter().map(|&(id, ..)| id).collect();
            emit_jobs_chunk(on_event, &type_jobs, &type_affinity)?;
        }
    }

    api.collect_pipeline_refusals(&decoder);
    Ok(total_jobs)
}
