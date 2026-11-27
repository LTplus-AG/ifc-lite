// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Job emission when the pre-pass plans content keys (`setGlobalKeyPlanning`).
//!
//! Every job's geometry-item key is computed BEFORE the first dispatch, the
//! repeated keys are planned once for the model (`global_key_plan.rs`), a
//! `global-key-plan` event reports the plan, and each `jobs` chunk carries its
//! jobs' `planIndex` beside the affinity. The same keys route equal geometry
//! to the same worker. Without key planning the pre-pass emits exactly as
//! before (`prepass_emit.rs`).

use super::global_key_plan::{build_key_plan, voided_hosts, KEY_PLAN_NONE};
use super::prepass_affinity::fold_u128_to_u32;
use super::prepass_events::emit_planned_jobs_chunk;
use ifc_lite_core::{ColumnarEntityIndex, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use js_sys::Function;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

type Job = (u32, usize, usize, IfcType);

/// Plan, then emit `jobs` as a first wave of `first_wave` jobs followed by
/// chunks of `chunk_size`, each with its affinity and plan indices.
pub(super) fn emit_planned_jobs(
    on_event: &Function,
    content: &[u8],
    index: &Arc<ColumnarEntityIndex>,
    jobs: &[Job],
    void_rels: &[(u32, usize, usize)],
    chunk_size: usize,
    first_wave: usize,
) -> Result<(), JsValue> {
    let mut decoder = EntityDecoder::with_arc_columnar_index(content, index.clone());
    let router = GeometryRouter::new(); // not drained: meshes nothing (issue_3821_auxiliary_routers_mesh_nothing.rs)
    // A class the viewer toggles as a class never instances, so it neither
    // counts toward a key's gate nor gets planned (`CLASS_TOGGLED_TYPES`).
    let keys: Vec<Option<u128>> = jobs
        .iter()
        .map(|(id, _, _, ifc_type)| {
            if super::batch_partition::is_class_toggled(ifc_type.name()) {
                return None;
            }
            decoder.decode_by_id(*id).ok().and_then(|e| router.geometry_item_key(&e, &mut decoder))
        })
        .collect();
    let ids: Vec<u32> = jobs.iter().map(|&(id, ..)| id).collect();
    let plan = build_key_plan(&ids, &keys, &voided_hosts(content, void_rels), super::global_plan::GLOBAL_INSTANCE_GATE);
    let event = js_sys::Object::new();
    crate::api::set_js_prop(&event, "type", &"global-key-plan".into());
    crate::api::set_js_prop(&event, "keys", &(plan.keys as f64).into());
    let planned = plan.job_plan.iter().filter(|&&p| p != KEY_PLAN_NONE).count();
    crate::api::set_js_prop(&event, "plannedJobs", &(planned as f64).into());
    on_event.call1(&JsValue::NULL, &event.into())?;

    let first = jobs.len().min(first_wave);
    // The first wave spreads by job id for first paint, as without planning;
    // content keys route the rest.
    let affinity: Vec<u32> = keys
        .iter()
        .zip(&ids)
        .enumerate()
        .map(|(j, (k, &id))| if j < first { id } else { k.map(fold_u128_to_u32).unwrap_or(id) })
        .collect();
    let chunk = |start: usize, end: usize| {
        emit_planned_jobs_chunk(on_event, &jobs[start..end], &affinity[start..end], Some(&plan.job_plan[start..end]))
    };
    chunk(0, first)?;
    for start in (first..jobs.len()).step_by(chunk_size.max(1)) {
        chunk(start, (start + chunk_size.max(1)).min(jobs.len()))?;
    }
    Ok(())
}
