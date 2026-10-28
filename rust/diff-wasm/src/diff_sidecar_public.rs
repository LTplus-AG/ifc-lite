// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Public live-value sidecar boundary, distinct from native JSON-text helpers.
use crate::diff_sidecar_host::*;
use js_sys::Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = diffCreateSidecarValue)]
pub fn create(value: JsValue, lineage: bool) -> Result<JsValue> {
    crate::diff_sidecar_create::create(&value, lineage)
}
#[wasm_bindgen(js_name = diffValidateSidecarValue, unchecked_return_type = "string[]")]
pub fn validate(value: JsValue, lineage: bool) -> Result<Array> {
    crate::diff_sidecar_observe::validate(&value, lineage)
}
#[wasm_bindgen(js_name = diffSidecarValueMismatches, unchecked_return_type = "string[]")]
pub fn mismatches(pinned: JsValue, models: JsValue, lineage: bool) -> Result<Array> {
    let errors = Array::new();
    let artifact = if lineage { "lineage" } else { "sidecar" };
    for side in ["base", "head"] {
        if get(&get(&pinned, side)?, "hash")? != get(&get(&models, side)?, "hash")? {
            errors.push(&message(&[
                format!("{side} model does not match the {artifact} ({artifact} ").into(),
                text(&get(&get(&pinned, side)?, "hash")?)?,
                ", got ".into(),
                text(&get(&get(&models, side)?, "hash")?)?,
                ")".into(),
            ])?);
        }
    }
    let empty = |v: JsValue| {
        if v.is_null() || v.is_undefined() {
            "".into()
        } else {
            v
        }
    };
    if empty(get(&pinned, "keyProperty")?) != empty(get(&models, "keyProperty")?) {
        let label = |v: JsValue| {
            if v.is_null() || v.is_undefined() {
                "GlobalId".into()
            } else {
                v
            }
        };
        errors.push(&message(&[
            format!("key scheme does not match the {artifact} ({artifact} ").into(),
            text(&label(get(&pinned, "keyProperty")?))?,
            ", got ".into(),
            text(&label(get(&models, "keyProperty")?))?,
            ")".into(),
        ])?);
    }
    Ok(errors)
}
#[wasm_bindgen(js_name = diffKeyAliasesFromSidecarValue, unchecked_return_type = "[string, string][]")]
pub fn aliases(value: JsValue) -> Result<Array> {
    let (claimed, conflicted) =
        crate::diff_sidecar_observe::identity_claims(&get(&value, "entries")?)?;
    let pairs = Array::new();
    visit(claimed.as_ref(), |pair| {
        let here = get_key(&pair, &JsValue::from_f64(0.0))?;
        let base = get_key(&pair, &JsValue::from_f64(1.0))?;
        if !conflicted.has(&here) && base != here {
            pairs.push(&Array::of2(&here, &base));
        }
        Ok(true)
    })?;
    Ok(pairs)
}

/// Host JSON observations preserve toJSON, unsupported values, and exceptions;
/// Rust owns the public operation's spacing and trailing-newline contract.
#[wasm_bindgen(js_name = diffSerializeSidecarValue, unchecked_return_type = "string")]
pub fn serialize(value: JsValue) -> Result<JsValue> {
    let json = get(&js_sys::global(), "JSON")?;
    let wire = call(&json, "stringify", &Array::of3(&value, &JsValue::NULL, &2.into()))?;
    let rendered = crate::diff_transport::string(&text(&wire)?)?;
    let mut units = rendered.units().to_vec();
    units.push(u16::from(b'\n'));
    Ok(crate::diff_transport::host_string(&ifc_lite_diff::JsString::from_units(units)))
}
