// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Caught host observations. No sidecar fields, rules or canonicalization live here.
use js_sys::{Array, Function};
use wasm_bindgen::{closure::ScopedClosure, prelude::*};

#[wasm_bindgen(inline_js = r#"
export function scGet(value, key) { return value[key]; }
export function scObject(value) { return typeof value === 'object' && value !== null; }
export function scArray(value) { return Array.isArray(value); }
export function scVisit(value, callback) { for (const item of value) if (!callback(item)) break; }
export function scCall(value, name, args) { return value[name](...args); }
export function scText(value) { return `${value}`; }
export function scLess(a, b) { return a < b; }
export function scGreater(a, b) { return a > b; }
export function scTruthy(value) { return !!value; }
export function scDate(value) { return Date.parse(value); }
export function scError(message) { return new Error(message); }
export function scDefine(value, key, item) { Object.defineProperty(value, key, {value:item, enumerable:true, configurable:true, writable:true}); }
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = scGet)]
    pub fn get_key(value: &JsValue, key: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = scObject)]
    pub fn object(value: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = scArray)]
    pub fn array(value: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = scVisit)]
    fn host_visit(value: &JsValue, callback: &Function) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = scCall)]
    pub fn call(value: &JsValue, name: &str, args: &Array) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = scText)]
    pub fn text(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = scLess)]
    fn less(a: &JsValue, b: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = scGreater)]
    fn greater(a: &JsValue, b: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(js_name = scTruthy)]
    pub fn truthy(value: &JsValue) -> bool;
    #[wasm_bindgen(catch, js_name = scDefine)]
    fn define(value: &JsValue, key: &str, item: &JsValue) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = scError)]
    pub fn error(message: &JsValue) -> JsValue;
    #[wasm_bindgen(catch, js_name = scDate)]
    pub fn date(value: &JsValue) -> Result<f64, JsValue>;
}
pub type Result<T, E = JsValue> = std::result::Result<T, E>;
pub fn get(value: &JsValue, key: &str) -> Result<JsValue> {
    get_key(value, &key.into())
}
pub fn len(value: &JsValue) -> Result<JsValue> {
    get(value, "length")
}
pub fn record(value: &JsValue) -> Result<bool> {
    Ok(object(value)? && !array(value)?)
}
pub fn equal(value: &JsValue, expected: &str) -> bool {
    value == &JsValue::from_str(expected)
}
pub fn visit(value: &JsValue, mut callback: impl FnMut(JsValue) -> Result<bool>) -> Result<()> {
    let closure =
        ScopedClosure::<dyn FnMut(JsValue) -> Result<bool>>::borrow_mut_aborting(&mut callback);
    host_visit(value, closure.as_ref().unchecked_ref())
}
pub fn method_predicate(
    value: &JsValue,
    method: &str,
    predicate: impl Fn(JsValue) -> Result<bool> + 'static,
) -> Result<JsValue> {
    // A user-supplied method can keep its callback. Transfer these owned
    // closures to the host GC rather than invalidating them on return.
    let closure =
        Closure::wrap_aborting(Box::new(predicate) as Box<dyn Fn(JsValue) -> Result<bool>>)
            .into_js_value();
    let args = Array::new();
    args.push(&closure);
    call(value, method, &args)
}
pub fn compare(a: &JsValue, b: &JsValue) -> Result<i32> {
    Ok(if less(a, b)? {
        -1
    } else if greater(a, b)? {
        1
    } else {
        0
    })
}
pub fn sort_result(
    value: &JsValue,
    compare: impl Fn(JsValue, JsValue) -> Result<i32> + 'static,
) -> Result<JsValue> {
    let closure =
        Closure::wrap_aborting(Box::new(compare) as Box<dyn Fn(JsValue, JsValue) -> Result<i32>>)
            .into_js_value();
    let args = Array::new();
    args.push(&closure);
    call(value, "sort", &args)
}
pub fn sort(
    value: &JsValue,
    compare: impl Fn(JsValue, JsValue) -> Result<i32> + 'static,
) -> Result<()> {
    sort_result(value, compare)?;
    Ok(())
}
pub fn sorted(values: &js_sys::Set) -> Result<Array> {
    let result = copy(values.as_ref())?;
    sort(result.as_ref(), |a, b| compare(&a, &b))?;
    Ok(result)
}
pub fn copy(value: &JsValue) -> Result<Array> {
    let result = Array::new();
    visit(value, |v| {
        result.push(&v);
        Ok(true)
    })?;
    Ok(result)
}
pub fn message(parts: &[JsValue]) -> Result<JsValue> {
    let array = Array::new();
    for part in parts {
        array.push(part);
    }
    call(array.as_ref(), "join", &Array::of1(&"".into()))
}
pub fn push_message(errors: &Array, prefix: &str, value: &JsValue, suffix: &str) -> Result<()> {
    errors.push(&message(&[prefix.into(), text(value)?, suffix.into()])?);
    Ok(())
}
pub fn set(value: &JsValue, key: &str, item: &JsValue) -> Result<()> {
    define(value, key, item)
}
