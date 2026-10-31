// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::IfcType;
use js_sys::Function;
use wasm_bindgen::prelude::*;

pub(super) fn emit_meta(
    on_event: &Function,
    meta_res: &ifc_lite_processing::stream_meta::StreamMeta,
) -> Result<(), JsValue> {
    let meta = js_sys::Object::new();
    crate::api::set_js_prop(&meta, "type", &"meta".into());
    super::prepass_sharded::set_stream_meta_props(&meta, meta_res);
    on_event.call1(&JsValue::NULL, &meta.into())?;
    Ok(())
}

pub(super) fn emit_jobs_chunk(
    on_event: &Function,
    jobs: &[(u32, usize, usize, IfcType)],
    affinity: &[u32],
) -> Result<(), JsValue> {
    if jobs.is_empty() {
        return Ok(());
    }
    let arr = js_sys::Uint32Array::new_with_length((jobs.len() * 3) as u32);
    let aff = js_sys::Uint32Array::new_with_length(jobs.len() as u32);
    let mut idx = 0u32;
    for (j, &(id, start, end, _)) in jobs.iter().enumerate() {
        arr.set_index(idx, id);
        arr.set_index(idx + 1, start as u32);
        arr.set_index(idx + 2, end as u32);
        idx += 3;
        aff.set_index(j as u32, affinity.get(j).copied().unwrap_or(id));
    }
    let event = js_sys::Object::new();
    crate::api::set_js_prop(&event, "type", &"jobs".into());
    crate::api::set_js_prop(&event, "jobs", &arr);
    crate::api::set_js_prop(&event, "affinity", &aff);
    on_event.call1(&JsValue::NULL, &event.into())?;
    Ok(())
}
