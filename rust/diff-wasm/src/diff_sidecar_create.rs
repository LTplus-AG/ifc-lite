// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Creation projects known fields; Rust owns delimiter signatures, sorting and validation.
use crate::diff_sidecar_host::*;
use js_sys::{Array, Object, Set};
use wasm_bindgen::prelude::*;

fn normalize_model(value: &JsValue) -> Result<JsValue> {
    let result: JsValue = Object::new().into();
    set(&result, "hash", &get(value, "hash")?)?;
    if !get(value, "path")?.is_undefined() {
        set(&result, "path", &get(value, "path")?)?;
    }
    Ok(result)
}
fn signature(entry: &JsValue, lineage: bool) -> Result<JsValue> {
    if lineage {
        message(&[
            text(&get(entry, "relation")?)?,
            "\0".into(),
            text(&call(
                &get(entry, "base")?,
                "join",
                &Array::of1(&"\u{1}".into()),
            )?)?,
            "\0".into(),
            text(&call(
                &get(entry, "head")?,
                "join",
                &Array::of1(&"\u{1}".into()),
            )?)?,
        ])
    } else {
        message(&[
            text(&get(entry, "base")?)?,
            "\0".into(),
            text(&get(entry, "here")?)?,
        ])
    }
}
fn normalize_entry(entry: &JsValue, lineage: bool) -> Result<JsValue> {
    let result: JsValue = Object::new().into();
    if lineage {
        set(&result, "base", copy(&get(entry, "base")?)?.as_ref())?;
        set(&result, "head", copy(&get(entry, "head")?)?.as_ref())?;
        set(&result, "relation", &get(entry, "relation")?)?;
        set(&result, "reason", &get(entry, "reason")?)?;
        if truthy(&get(entry, "shares")?) {
            set(&result, "shares", copy(&get(entry, "shares")?)?.as_ref())?;
        }
    } else {
        for field in ["base", "here", "reason"] {
            set(&result, field, &get(entry, field)?)?;
        }
    }
    Ok(result)
}
fn first(entry: &JsValue, side: &str) -> Result<JsValue> {
    let value = get_key(&get(entry, side)?, &JsValue::from_f64(0.0))?;
    Ok(if value.is_null() || value.is_undefined() {
        "".into()
    } else {
        value
    })
}
fn compare_entry(a: &JsValue, b: &JsValue, lineage: bool) -> Result<i32> {
    if lineage {
        let base = compare(&first(a, "base")?, &first(b, "base")?)?;
        if base != 0 {
            Ok(base)
        } else {
            compare(&first(a, "head")?, &first(b, "head")?)
        }
    } else if get(a, "base")? == get(b, "base")? {
        compare(&get(a, "here")?, &get(b, "here")?)
    } else {
        compare(&get(a, "base")?, &get(b, "base")?)
    }
}
pub fn validate_created(value: &JsValue, lineage: bool) -> Result<()> {
    let errors = crate::diff_sidecar_observe::validate(value, lineage)?;
    if errors.length() > 0 {
        let label = if lineage {
            "Invalid lineage sidecar: "
        } else {
            "Invalid identity-map sidecar: "
        };
        return Err(error(&message(&[
            label.into(),
            call(errors.as_ref(), "join", &Array::of1(&"; ".into()))?,
        ])?));
    }
    Ok(())
}
pub fn create(init: &JsValue, lineage: bool) -> Result<JsValue> {
    let seen = Set::new(&JsValue::UNDEFINED);
    let entries = Array::new();
    visit(&get(init, "entries")?, |entry| {
        let signature = signature(&entry, lineage)?;
        // Preserve #8088: shared NUL/SOH signatures intentionally collide.
        if seen.has(&signature) {
            return Ok(true);
        }
        seen.add(&signature);
        entries.push(&normalize_entry(&entry, lineage)?);
        Ok(true)
    })?;
    sort(entries.as_ref(), move |a, b| compare_entry(&a, &b, lineage))?;
    let result: JsValue = Object::new().into();
    set(
        &result,
        "format",
        &if lineage {
            "ifc-lite/lineage"
        } else {
            "ifc-lite/identity-map"
        }
        .into(),
    )?;
    set(
        &result,
        "version",
        &JsValue::from_f64(if get(init, "keyProperty")?.is_undefined() {
            1.0
        } else {
            2.0
        }),
    )?;
    set(&result, "base", &normalize_model(&get(init, "base")?)?)?;
    set(&result, "head", &normalize_model(&get(init, "head")?)?)?;
    set(&result, "entries", entries.as_ref())?;
    if lineage {
        let deleted = get(init, "deleted")?;
        let unique = Set::new(&JsValue::UNDEFINED);
        if !deleted.is_null() && !deleted.is_undefined() {
            visit(&deleted, |key| {
                unique.add(&key);
                Ok(true)
            })?;
        }
        let deleted = sorted(&unique)?;
        set(&result, "deleted", deleted.as_ref())?;
    }
    for field in ["created", "keyProperty"] {
        if !get(init, field)?.is_undefined() {
            set(&result, field, &get(init, field)?)?;
        }
    }
    validate_created(&result, lineage)?;
    Ok(result)
}
