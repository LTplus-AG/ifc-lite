// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! All sidecar operations use the same lossless UTF-16 document transport.
use ifc_lite_diff::sidecar_document::{create_sidecar_document, parse_ordered_json,
    serialize_sidecar, validate_sidecar_document, SidecarDocumentError, SidecarKind};
use wasm_bindgen::prelude::*;
use js_sys::JsString;
use std::fmt::Write as _;

#[wasm_bindgen]
extern "C" {
    // js_sys::JSON::parse accepts &str, which would already replace lone units.
    #[wasm_bindgen(js_namespace = JSON, js_name = parse, catch)]
    fn parse_original_json(text: &JsString) -> Result<JsValue, JsValue>;
}

fn normalize_json(text: &JsString) -> Result<String, JsValue> {
    let mut normalized = String::new();
    let mut checked_original = false;
    for unit in char::decode_utf16(text.iter()) {
        match unit {
            Ok(scalar) => normalized.push(scalar),
            Err(error) => {
                // #8081 / review 4365117575: only normalize valid ORIGINAL JSON.
                // Otherwise an invalid backslash + raw surrogate could become
                // a valid escaped backslash followed by ordinary "uXXXX" text.
                if !checked_original {
                    parse_original_json(text)?;
                    checked_original = true;
                }
                // Standard JSON escaping, distinct from a literal backslash-u.
                write!(normalized, "\\u{:04x}", error.unpaired_surrogate())
                    .expect("writing to String cannot fail");
            }
        }
    }
    Ok(normalized)
}

fn kind(lineage: bool) -> SidecarKind { if lineage { SidecarKind::Lineage } else { SidecarKind::Identity } }
fn valid_date(text: &str) -> bool { js_sys::Date::parse(text).is_finite() }
fn document_error(error: SidecarDocumentError) -> JsValue {
    match js_sys::JSON::parse(&error.to_json()) { Ok(message) => message, Err(error) => error }
}
/// Normalize, deduplicate and validate an identity or lineage sidecar.
#[wasm_bindgen(js_name = diffCreateSidecar)]
pub fn diff_create_sidecar(text: JsString, lineage: bool) -> Result<String, JsValue> {
    let value = parse_ordered_json(&normalize_json(&text)?)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let created = create_sidecar_document(&value, kind(lineage), valid_date).map_err(document_error)?;
    Ok(serialize_sidecar(&created))
}
/// Host decoding preserves lone UTF-16 units even inside conflict diagnostics.
#[wasm_bindgen(js_name = diffValidateSidecar, unchecked_return_type = "string[]")]
pub fn diff_validate_sidecar(text: JsString, lineage: bool) -> Result<js_sys::Array<js_sys::JsString>, JsValue> {
    let value = parse_ordered_json(&normalize_json(&text)?)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let errors = validate_sidecar_document(&value, kind(lineage), valid_date);
    Ok(js_sys::JSON::parse(&serialize_sidecar(&errors))?.unchecked_into())
}
/// Emit JSON.stringify-compatible pretty bytes and the trailing newline.
#[wasm_bindgen(js_name = diffSerializeSidecar)]
pub fn diff_serialize_sidecar(text: JsString) -> Result<String, JsValue> {
    let ordered = parse_ordered_json(&normalize_json(&text)?)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(serialize_sidecar(&ordered))
}
