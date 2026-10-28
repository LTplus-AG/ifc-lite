// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Live-value validation: retain short circuiting, repeat reads and host exceptions.
use crate::diff_sidecar_host::*;
use js_sys::{Array, Map, Set};
use wasm_bindgen::prelude::*;

fn model(value: &JsValue, side: &str, errors: &Array) -> Result<()> {
    if !record(value)? {
        errors.push(&format!("{side} must be {{ hash, path? }}").into());
        return Ok(());
    }
    if !get(value, "hash")?.is_string() || len(&get(value, "hash")?)? == JsValue::from_f64(0.0) {
        errors.push(&format!("{side}.hash must be a non-empty content digest").into());
    }
    if !get(value, "path")?.is_undefined() && !get(value, "path")?.is_string() {
        errors.push(&format!("{side}.path must be a string when present").into());
    }
    Ok(())
}
fn common(value: &JsValue, lineage: bool, errors: &Array) -> Result<()> {
    let format = if lineage {
        "ifc-lite/lineage"
    } else {
        "ifc-lite/identity-map"
    };
    if !equal(&get(value, "format")?, format) {
        errors.push(&format!("format must be \"{format}\"").into());
    }
    let one = JsValue::from_f64(1.0);
    let two = JsValue::from_f64(2.0);
    if get(value, "version")? != one && get(value, "version")? != two {
        errors.push(&"version must be 1 or 2".into());
    } else if lineage {
        if get(value, "version")? == two && get(value, "keyProperty")?.is_undefined() {
            errors.push(&"version 2 requires keyProperty".into());
        }
    } else if get(value, "keyProperty")?.is_undefined() == (get(value, "version")? == two) {
        errors.push(&"version 2 requires keyProperty and version 1 forbids it".into());
    }
    for side in ["base", "head"] {
        model(&get(value, side)?, side, errors)?;
    }
    let created = get(value, "created")?;
    if !created.is_undefined() && (!created.is_string() || truthy(&date_nan(&created)?)) {
        errors.push(&"created must be an ISO 8601 timestamp when present".into());
    }
    let key = get(value, "keyProperty")?;
    if !key.is_undefined()
        && (!key.is_string() || len(&call(&key, "trim", &Array::new())?)? == JsValue::from_f64(0.0))
    {
        errors.push(&"keyProperty must be a non-empty string when present".into());
    }
    Ok(())
}
pub fn identity_claims(entries: &JsValue) -> Result<(Map, Set)> {
    let claimed = Map::new();
    let conflicts = Set::new(&JsValue::UNDEFINED);
    visit(entries, |entry| {
        let previous = claimed.get(&get(&entry, "here")?);
        if previous.is_undefined() {
            claimed.set(&get(&entry, "here")?, &get(&entry, "base")?);
        } else if previous != get(&entry, "base")? {
            conflicts.add(&get(&entry, "here")?);
        }
        Ok(true)
    })?;
    Ok((claimed, conflicts))
}
fn identity(value: &JsValue, errors: &Array) -> Result<()> {
    if !array(&get(value, "entries")?)? {
        errors.push(&"entries must be an array".into());
        return Ok(());
    }
    let mut shaped = true;
    visit(&get(value, "entries")?, |entry| {
        if !record(&entry)?
            || !get(&entry, "base")?.is_string()
            || !get(&entry, "here")?.is_string()
            || !get(&entry, "reason")?.is_string()
        {
            errors.push(&"entries must be { base, here, reason } with string fields".into());
            shaped = false;
            return Ok(false);
        }
        Ok(true)
    })?;
    if shaped {
        let (_, conflicts) = identity_claims(&get(value, "entries")?)?;
        for here in sorted(&conflicts)?.iter() {
            push_message(
                errors,
                "entries claim two different base identities for here \"",
                &here,
                "\"",
            )?;
        }
    }
    Ok(())
}
/// No recursive traversal or JSON DTO: ignored values are never observed, and
/// all finite file data is handled at the host's depth rather than serde's cap.
pub fn validate(value: &JsValue, lineage: bool) -> Result<Array> {
    let errors = Array::new();
    if !record(value)? {
        errors.push(&"sidecar must be an object".into());
        return Ok(errors);
    }
    common(value, lineage, &errors)?;
    if lineage {
        crate::diff_sidecar_lineage::validate(value, &errors)?;
    } else {
        identity(value, &errors)?;
    }
    Ok(errors)
}
