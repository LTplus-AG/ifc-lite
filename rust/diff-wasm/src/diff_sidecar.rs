// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! All sidecar operations use the same lossless UTF-16 document transport.
use ifc_lite_diff::sidecar_document::{create_sidecar_document, parse_ordered_json,
    serialize_sidecar, validate_sidecar_document, SidecarDocumentError, SidecarKind};
use wasm_bindgen::prelude::*;

fn kind(lineage: bool) -> SidecarKind { if lineage { SidecarKind::Lineage } else { SidecarKind::Identity } }
fn valid_date(text: &str) -> bool { js_sys::Date::parse(text).is_finite() }
fn document_error(error: SidecarDocumentError) -> JsValue {
    match js_sys::JSON::parse(&error.to_json()) { Ok(message) => message, Err(error) => error }
}
/// Normalize, deduplicate and validate an identity or lineage sidecar.
#[wasm_bindgen(js_name = diffCreateSidecar)]
pub fn diff_create_sidecar(text: &str, lineage: bool) -> Result<String, JsValue> {
    let value = parse_ordered_json(text).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let created = create_sidecar_document(&value, kind(lineage), valid_date).map_err(document_error)?;
    Ok(serialize_sidecar(&created))
}
/// Host decoding preserves lone UTF-16 units even inside conflict diagnostics.
#[wasm_bindgen(js_name = diffValidateSidecar, unchecked_return_type = "string[]")]
pub fn diff_validate_sidecar(text: &str, lineage: bool) -> Result<js_sys::Array<js_sys::JsString>, JsValue> {
    let value = parse_ordered_json(text).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let errors = validate_sidecar_document(&value, kind(lineage), valid_date);
    Ok(js_sys::JSON::parse(&serialize_sidecar(&errors))?.unchecked_into())
}
/// Emit JSON.stringify-compatible pretty bytes and the trailing newline.
#[wasm_bindgen(js_name = diffSerializeSidecar)]
pub fn diff_serialize_sidecar(text: &str) -> Result<String, JsValue> {
    let ordered = parse_ordered_json(text).map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(serialize_sidecar(&ordered))
}
