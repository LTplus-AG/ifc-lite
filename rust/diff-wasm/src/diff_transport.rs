// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Every string crossing uses UTF-16 code units, including object keys.
use ifc_lite_diff::{DocumentValue as Value, JsString};
use wasm_bindgen::{prelude::*, JsCast};

pub(crate) fn string(value: &JsValue) -> Result<JsString, JsValue> {
    if !value.is_string() { return Err(JsValue::from_str("expected a string")); }
    // The scalar copy is fast for ordinary IFC strings. A strict round-trip
    // identity check detects replacement of lone surrogates; only those strings
    // need individual code-unit reads. Never trust the lossy copy alone.
    if let Some(scalar) = value.as_string() {
        if JsValue::from_str(&scalar) == *value { return Ok(scalar.into()); }
    }
    let value: &js_sys::JsString = value.unchecked_ref();
    Ok(JsString::from_units((0..value.length()).map(|i| value.char_code_at(i) as u16).collect()))
}
pub(crate) fn host_string(value: &JsString) -> JsValue {
    if let Some(scalar) = value.as_str() { return JsValue::from_str(scalar); }
    // Bounded chunks avoid the host's argument-count limit for long strings.
    let mut result = js_sys::JsString::from("");
    for chunk in value.units().chunks(4096) {
        result = result.concat(&js_sys::JsString::from_char_code(chunk));
    }
    result.into()
}
pub(crate) fn host_value(value: &Value) -> Result<JsValue, JsValue> {
    Ok(match value {
        Value::Null => JsValue::NULL, Value::Bool(b) => JsValue::from_bool(*b),
        Value::Number(n) => JsValue::from_f64(*n), Value::String(s) => host_string(s),
        Value::Array(a) => {
            let array = js_sys::Array::new();
            for value in a { array.push(&host_value(value)?); }
            array.into()
        },
        Value::Object(o) => {
            let object = js_sys::Object::new();
            for (key, value) in o {
                // Define an own data property: Reflect.set("__proto__") invokes
                // Object.prototype's setter rather than preserving that key.
                let descriptor = js_sys::Object::new();
                js_sys::Reflect::set(&descriptor, &"value".into(), &host_value(value)?)?;
                for flag in ["enumerable", "configurable", "writable"] {
                    js_sys::Reflect::set(&descriptor, &flag.into(), &JsValue::TRUE)?;
                }
                js_sys::Reflect::define_property(&object, &host_string(key), &descriptor)?;
            }
            object.into()
        },
    })
}
