// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Prepare runtime Unicode mappings before any pure diff-engine frame is live.
use ifc_lite_diff::{engine::DiffOptions, model::EntityFingerprint, JsString};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

// Use the running host's methods on a primitive, just like the independent TS
// oracle. Do not capture a Unicode version or embed another casing table.
// The contract assumes standard intrinsics: overriding String.prototype with
// stateful/non-idempotent methods cannot preserve the TS observation sequence
// while also keeping the Rust algorithm pure and the ASCII path host-call-free.
#[wasm_bindgen(inline_js = "export function normalizeDiffClass(value) { return value.trim().toUpperCase(); }")]
extern "C" {
    #[wasm_bindgen(catch, js_name = normalizeDiffClass)]
    fn normalize_class(value: &JsValue) -> Result<JsValue, JsValue>;
}

fn non_ascii(value: &JsString) -> bool { value.units().iter().any(|unit| *unit > 0x7f) }

/// Retain only actual class names, never other dictionary entries. No host I/O.
pub(crate) fn model_classes(entities: &[EntityFingerprint<usize>]) -> Vec<JsString> {
    let mut seen = HashSet::new();
    entities.iter().map(|entity| &entity.ifc_type)
        .filter(|name| non_ascii(name) && seen.insert(*name)).cloned().collect()
}

pub(crate) fn mappings(base: &[JsString], head: &[JsString], options: &DiffOptions)
    -> Result<HashMap<JsString, JsString>, JsValue> {
    let mut seen = HashSet::new();
    let mut result = HashMap::new();
    let names = base.iter().chain(head).chain(&options.key.exclude_types)
        .chain(options.class_families.iter().flatten().flatten());
    for name in names.filter(|name| non_ascii(name) && seen.insert(*name)) {
        // catch converts the original exception to Err before Rust can unwind
        // past engine-owned allocations. No core RefCell borrow exists here.
        let normalized = normalize_class(&crate::diff_transport::host_string(name))?;
        result.insert(name.clone(), crate::diff_transport::string(&normalized)?);
    }
    Ok(result)
}
