// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Rust canonicalization with the original live host observations/exceptions.
use crate::diff_transport::{host_string, string};
use ifc_lite_diff::JsString;
use js_sys::Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function diffOwnKeys(value) { return Object.keys(value); }
export function diffIsArray(value) { return Array.isArray(value); }
export function diffAtomJSON(value) { return JSON.stringify(value) ?? 'null'; }
// Only host observation/traversal lives here. Rust returns an atom token,
// null for an array, or sorted object keys, and assembles every composite.
export function diffObserveTree(value, enter, finishArray, finishObject) {
    function visit(value) {
        const plan = enter(value);
        if (typeof plan === 'string') return plan;
        if (plan === null) {
            // Preserve live method lookup, receiver, species, holes, immediate
            // callback results, and template ToString (which rejects Symbols).
            return finishArray(`${value.map(visit).join(',')}`);
        }
        const children = [];
        for (let index = 0; index < plan.length; index++) {
            children[index] = visit(value[plan[index]]);
        }
        return finishObject(plan, children);
    }
    return visit(value);
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = diffOwnKeys)]
    fn own_keys(value: &JsValue) -> Result<Array, JsValue>;
    #[wasm_bindgen(catch, js_name = diffIsArray)]
    fn is_array(value: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = diffAtomJSON)]
    fn atom_json(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = diffObserveTree)]
    fn observe_tree(value: &JsValue, enter: &JsValue, finish_array: &JsValue, finish_object: &JsValue)
        -> Result<JsValue, JsValue>;
}
fn append(result: &mut Vec<u16>, value: JsValue) -> Result<(), JsValue> {
    result.extend_from_slice(string(&value)?.units());
    Ok(())
}
/// Each call returns before the host visits a child: no per-level Rust or
/// wasm-bindgen callback frames remain on the recursion stack (#8042).
fn enter_node(value: JsValue) -> Result<JsValue, JsValue> {
    if value.is_null() || !value.is_object() { return atom_json(&value); }
    if is_array(&value)? { return Ok(JsValue::NULL); }
    let mut keys: Vec<_> = own_keys(&value)?.iter().map(|key| {
        string(&key).map(|units| (units, key))
    }).collect::<Result<_, _>>()?;
    keys.sort_by(|a, b| a.0.units().cmp(b.0.units()));
    let sorted = Array::new();
    for (_, key) in keys { sorted.push(&key); }
    Ok(sorted.into())
}
fn finish_array(body: JsValue) -> Result<JsValue, JsValue> {
    Ok(host_string(&JsString::surround("[", &string(&body)?, "]")))
}
fn finish_object(keys: Array, children: Array) -> Result<JsValue, JsValue> {
    let mut result = vec![u16::from(b'{')];
    for index in 0..keys.length() {
        if index > 0 { result.push(u16::from(b',')); }
        let mut quoted = String::new();
        string(&keys.get(index))?.write_json(&mut quoted);
        result.extend(quoted.encode_utf16());
        result.push(u16::from(b':'));
        append(&mut result, children.get(index))?;
    }
    result.push(u16::from(b'}'));
    Ok(host_string(&JsString::from_units(result)))
}
fn stable_serialize(value: JsValue) -> Result<JsValue, JsValue> {
    // A custom map can retain visit, even after throwing, and can reenter it.
    // Its JS closure owns these GC-managed immutable Fn closures: no borrowed
    // callback, active mutable borrow, path state, or traversal depth survives.
    let enter = Closure::wrap_aborting(Box::new(enter_node)
        as Box<dyn Fn(JsValue) -> Result<JsValue, JsValue>>).into_js_value();
    let array = Closure::wrap_aborting(Box::new(finish_array)
        as Box<dyn Fn(JsValue) -> Result<JsValue, JsValue>>).into_js_value();
    let object = Closure::wrap_aborting(Box::new(finish_object)
        as Box<dyn Fn(Array, Array) -> Result<JsValue, JsValue>>).into_js_value();
    // Identity is not a cycle proof: a getter may revisit an object and then
    // terminate. Infinite graphs retain the host's catchable stack exception;
    // there is no fixed depth/work cutoff and no recursive Rust stack growth.
    observe_tree(&value, &enter, &array, &object)
}

/// Rust owns normalization; the facade retains host warning/String fallback.
#[wasm_bindgen(js_name = diffNormalizeValue, unchecked_return_type = "string | number | boolean | null")]
pub fn diff_normalize_value(value: JsValue) -> Result<JsValue, JsValue> {
    if value.is_null() || value.is_undefined() { return Ok(JsValue::NULL); }
    if let Some(number) = value.as_f64() {
        return Ok(if number.is_finite() { value } else {
            JsValue::from_str(if number.is_nan() { "NaN" } else if number.is_sign_positive() { "Infinity" } else { "-Infinity" })
        });
    }
    if value.is_string() || value.as_bool().is_some() { return Ok(value); }
    stable_serialize(value)
}
