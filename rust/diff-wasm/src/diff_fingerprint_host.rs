// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Host-only operations for the private fingerprint deserializer (#8114).
//! No callback into an owning Rust frame is used to catch an observation.
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function fpLength(value) { return value.length >>> 0; }
// Sparse collections follow Array.prototype.map instead (#8114): ToLength,
// then ArrayCreate's RangeError above 2^32 - 1, never a ToUint32 wrap into a
// walk. One length Get and one ToNumber (unary plus throws for BigInt/Symbol,
// like ToLength). Plain arithmetic, not mutable Math/Number globals.
export function fpSparseLength(value) {
    const number = +value.length;
    if (!(number > 0)) return 0; // NaN, -0, negative and -Infinity
    // The intrinsic Array length setter raises Array(len)'s own RangeError.
    if (number >= 4294967296) [].length = number;
    return number - number % 1;
}
export function fpIterable(value) { return Symbol.iterator in value; }
// Keep wasm-bindgen 0.2.126's non-throwing instanceof cast probes. Unlike
// member observations, a failed cast probe has always meant false here.
function instance(value, type) {
    try { return value instanceof type; }
    catch (error) { return false; }
}
export function fpMap(value) { return instance(value, Map); }
export function fpIterator(value) {
    const method = Reflect.get(value, Symbol.iterator);
    if (typeof method !== 'function') return undefined;
    const iterator = method.call(value);
    return typeof iterator === 'object' && iterator !== null && typeof iterator.next === 'function'
        ? iterator : undefined;
}
export function fpNext(iterator) { return iterator.next(); }
// js-sys's typed bool getter crosses the wasm i32 ABI, then tests != 0.
// Perform that coercion inside the catch too (a supplied value can coerce).
export function fpDone(step) { return step.done >>> 0; }
export function fpEntries(value) { return Object.entries(value); }
export function fpBytes(value) {
    if (instance(value, Uint8Array)) {
        // Copy inside this caught import; a proxy can pass instanceof yet
        // reject typed-array access. Only a fresh owned array reaches Rust.
        // Mirror js-sys 0.3.103 to_vec's capacity, raw-slice and copy_to
        // length reads, including each wasm u32 coercion, in that order.
        const capacity = value.length >>> 0;
        const copy = new Uint8Array(capacity);
        const sliceLength = value.length >>> 0;
        const checkedLength = value.length >>> 0;
        // Changing lengths can violate the original unsafe allocation/slice
        // assumptions or panic copy_to. Reject without claiming parity there.
        if (capacity !== sliceLength || sliceLength !== checkedLength) {
            throw new TypeError('inconsistent Uint8Array length during fingerprint decode');
        }
        copy.set(value);
        return copy;
    }
    if (instance(value, ArrayBuffer)) return new Uint8Array(value).slice();
    return undefined;
}
// Match wasm-bindgen's diagnostic formatting without invoking its uncaught
// debug-string import on a host object. This is only an invalid-type path.
function debug(value) {
    const type = typeof value;
    if (type === 'number' || type === 'boolean' || value == null) return `${value}`;
    if (type === 'string') return `"${value}"`;
    if (type === 'symbol') {
        const description = value.description;
        return description == null ? 'Symbol' : `Symbol(${description})`;
    }
    if (type === 'function') {
        const name = value.name;
        return typeof name === 'string' && name.length > 0 ? `Function(${name})` : 'Function';
    }
    if (Array.isArray(value)) {
        const length = value.length;
        let result = '[';
        if (length > 0) result += debug(value[0]);
        for (let i = 1; i < length; i++) result += ', ' + debug(value[i]);
        return result + ']';
    }
    const match = /\[object ([^\]]+)\]/.exec(Object.prototype.toString.call(value));
    if (!match || match.length <= 1) return Object.prototype.toString.call(value);
    const name = match[1];
    if (name === 'Object') {
        try { return 'Object(' + JSON.stringify(value) + ')'; }
        catch (error) { return 'Object'; } // wasm-bindgen's circular-object diagnostic
    }
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack}`;
    return name;
}
export function fpDebug(value) { return `JsValue(${debug(value)})`; }
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = fpLength)]
    pub fn array_length(value: &JsValue) -> Result<u32, JsValue>;
    #[wasm_bindgen(catch, js_name = fpSparseLength)]
    pub fn sparse_array_length(value: &JsValue) -> Result<u32, JsValue>;
    #[wasm_bindgen(catch, js_name = fpIterable)]
    pub fn iterable(value: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = fpMap)]
    pub fn map(value: &JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = fpIterator)]
    pub fn iterator(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = fpNext)]
    pub fn next(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = fpDone)]
    pub fn done(value: &JsValue) -> Result<u32, JsValue>;
    #[wasm_bindgen(catch, js_name = fpEntries)]
    pub fn entries(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = fpBytes)]
    pub fn bytes(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = fpDebug)]
    pub fn debug(value: &JsValue) -> Result<String, JsValue>;
}
