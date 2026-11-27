// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The pre-pass `sparse-facts` event (out-of-core ingest): the preamble and
//! inverse edges every sparse worker installs before its first batch.
use super::sparse_facts::SparseFacts;
use crate::api::IfcAPI;
use ifc_lite_core::ColumnarEntityIndex;
use js_sys::Function;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Ask the serial streaming pre-pass to also emit
    /// `{ type: "sparse-facts", preamble, inverseTargets, inverseReferrers }`
    /// right after its `entity-index` event. The event carries `unsupported`
    /// (a reason) instead when the file cannot be meshed from a sparse arena:
    /// the host then keeps its workers on the whole-file path.
    #[wasm_bindgen(js_name = setEmitSparseFacts)]
    pub fn set_emit_sparse_facts(&self, on: bool) {
        self.content.emit_sparse_facts.store(on, std::sync::atomic::Ordering::Relaxed);
    }
}

impl IfcAPI {
    pub(super) fn emits_sparse_facts(&self) -> bool {
        self.content.emit_sparse_facts.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub(super) fn emit_sparse_facts(
    on_event: &Function,
    content: &[u8],
    index: &ColumnarEntityIndex,
    facts: &SparseFacts,
) -> Result<(), JsValue> {
    let preamble = facts.preamble(content, |id| index.lookup(id));
    let event = js_sys::Object::new();
    crate::api::set_js_prop(&event, "type", &"sparse-facts".into());
    crate::api::set_js_prop(&event, "preamble", &js_sys::Uint8Array::from(preamble.as_slice()));
    crate::api::set_js_prop(
        &event,
        "inverseTargets",
        &js_sys::Uint32Array::from(facts.inverse_targets.as_slice()),
    );
    crate::api::set_js_prop(
        &event,
        "inverseReferrers",
        &js_sys::Uint32Array::from(facts.inverse_referrers.as_slice()),
    );
    if let Some(reason) = facts.refusal(index.len()) {
        crate::api::set_js_prop(&event, "unsupported", &reason.into());
    }
    on_event.call1(&JsValue::NULL, &event.into())?;
    Ok(())
}
