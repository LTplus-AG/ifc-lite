// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Sidecars are small JSON documents, unlike model fingerprint columns.
//! Date validation delegates to the host's Date.parse compatibility contract.
use ifc_lite_diff::{sidecar_document::{create_sidecar, parse_ordered_json, serialize_sidecar, SidecarKind},
    sidecar_validation::{validate_identity_sidecar, validate_lineage_sidecar}};
use wasm_bindgen::prelude::*;

fn value(text: &str) -> Result<serde_json::Value, JsValue> {
    serde_json::from_str(text).map_err(|error| JsValue::from_str(&error.to_string()))
}
fn valid_date(text: &str) -> bool { js_sys::Date::parse(text).is_finite() }

/// Normalize, deduplicate and validate an identity or lineage sidecar.
#[wasm_bindgen(js_name = diffCreateSidecar)]
pub fn diff_create_sidecar(text: &str, lineage: bool) -> Result<String, JsValue> {
    let kind = if lineage { SidecarKind::Lineage } else { SidecarKind::Identity };
    let created = create_sidecar(&value(text)?, kind, valid_date).map_err(|error| JsValue::from_str(&error))?;
    Ok(serialize_sidecar(&created))
}

/// Structural diagnostics preserve the engine's ordered error list.
#[wasm_bindgen(js_name = diffValidateSidecar)]
pub fn diff_validate_sidecar(text: &str, lineage: bool) -> Result<Vec<String>, JsValue> {
    let value = value(text)?;
    Ok(if lineage { validate_lineage_sidecar(&value, valid_date) }
        else { validate_identity_sidecar(&value, valid_date) })
}

/// Emit JSON.stringify-compatible pretty bytes and the trailing newline.
#[wasm_bindgen(js_name = diffSerializeSidecar)]
pub fn diff_serialize_sidecar(text: &str) -> Result<String, JsValue> {
    let ordered = parse_ordered_json(text).map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(serialize_sidecar(&ordered))
}
