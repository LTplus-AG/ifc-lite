// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A0p diagnostic entry. No IfcAPI member, numerical executor, or Worker.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::{inspect_retained_source, RetainedInspectionError};
use serde::Serialize;
use wasm_bindgen::prelude::*;

// Trusted build input, tracked by Cargo. Neither JS nor runtime HEAD can supply
// it. Qualification must match it to the original build request/receipt.
const BUILD_COMMIT: Option<&str> = option_env!("IFC_RETAINED_BUILD_COMMIT");

fn entry_error(code: serde_json::Value) -> JsValue {
    serde_json::json!({
        "kind": "entry_refused", "authority": "diagnostic_only", "code": code,
    }).serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .expect("finite diagnostic code serialization")
}

fn inspection_error(error: RetainedInspectionError) -> JsValue {
    // Consume the generated typed code, never classify Display/Debug text.
    entry_error(serde_json::from_str(&error.diagnostic_code_json())
        .expect("generated diagnostic code JSON"))
}

/// Inspect one product synchronously. The copied UTF-8 bytes are diagnostics
/// only: no geometry, executable recipe, or completion capability is returned.
/// Options are validated by the existing strict processing contract.
#[wasm_bindgen(js_name = inspectDevelopmentSource)]
pub fn inspect_development_source(
    data: &[u8], product_id: f64, options_json: &str,
) -> Result<Vec<u8>, JsValue> {
    let commit = BUILD_COMMIT.filter(|value| value.len() == 40
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .ok_or_else(|| entry_error(serde_json::json!("FEATURE_UNAVAILABLE")))?;
    // Accept f64 at the JS boundary: wasm-bindgen's u32 coercion would silently
    // turn -1, fractional, or >2^32 IDs into a different product request.
    if !product_id.is_finite() || product_id < 1. || product_id > u32::MAX as f64
        || product_id.fract() != 0. {
        return Err(entry_error(serde_json::json!("INVALID_OPTIONS")));
    }
    let source = SourceBundle::new(data.to_vec());
    let mut decoder = source.decoder();
    // No caller-provided decoder, root, or source hash can impersonate this
    // source's allocation identity. Processing decodes/authenticates the root.
    let report = inspect_retained_source(source.clone(), product_id as u32, None,
        &mut decoder, options_json, commit).map_err(inspection_error)?;
    let bytes = report.bytes().map_err(inspection_error)?.to_vec();
    // report/decoder/source release deterministically on success and error.
    Ok(bytes)
}
