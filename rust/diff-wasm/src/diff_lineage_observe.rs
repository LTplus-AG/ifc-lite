// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Public helpers consume live values, never a recursive whole-entry DTO.
//! Native typed lineage remains in ifc_lite_diff::lineage. Here Rust controls
//! observations because snapshotting a getter changes its meaning and timing.
use crate::diff_sidecar_host::*;
use js_sys::{Array, Map, Object, Set};
use wasm_bindgen::prelude::*;

// Generic host operators retain JS coercion and exceptions. Domain decisions
// and their short circuits live below, rather than in a JS algorithm fallback.
#[wasm_bindgen(inline_js = r#"
export function lineageLess(a, b) { return a < b; }
export function lineageGreater(a, b) { return a > b; }
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = lineageLess)]
    fn less(a: &JsValue, b: &JsValue) -> Result<bool>;
    #[wasm_bindgen(catch, js_name = lineageGreater)]
    fn greater(a: &JsValue, b: &JsValue) -> Result<bool>;
}
fn index(value: &JsValue, index: f64) -> Result<JsValue> {
    get_key(value, &index.into())
}
fn length(entry: &JsValue, side: &str) -> Result<JsValue> {
    len(&get(entry, side)?)
}

pub fn conflicts(entries: &JsValue) -> Result<JsValue> {
    let errors = Array::new();
    for side in ["base", "head"] {
        let seen = Set::new(&JsValue::UNDEFINED);
        let repeated = Set::new(&JsValue::UNDEFINED);
        visit(entries, |entry| {
            visit(&get(&entry, side)?, |key| {
                if seen.has(&key) { repeated.add(&key); }
                seen.add(&key);
                Ok(true)
            })?;
            Ok(true)
        })?;
        for key in sorted(&repeated)?.iter() {
            push_message(&errors, &format!("{side} key \""), &key,
                "\" appears in more than one lineage entry")?;
        }
    }
    Ok(errors.into())
}

pub fn aliases(entries: &JsValue) -> Result<JsValue> {
    let claims = Map::new();
    let conflicted = Set::new(&JsValue::UNDEFINED);
    visit(entries, |entry| {
        // Do not cache relation: the original expression observes it twice
        // when the first read is not identity (including changing getters).
        if !equal(&get(&entry, "relation")?, "identity")
            && !equal(&get(&entry, "relation")?, "replaced") { return Ok(true); }
        let one = JsValue::from_f64(1.0);
        if length(&entry, "base")? != one || length(&entry, "head")? != one {
            return Ok(true);
        }
        let here = index(&get(&entry, "head")?, 0.0)?;
        let base = index(&get(&entry, "base")?, 0.0)?;
        let claimed = claims.get(&here);
        if claimed.is_undefined() { claims.set(&here, &base); }
        else if claimed != base { conflicted.add(&here); }
        Ok(true)
    })?;
    let pairs = Array::new();
    visit(claims.as_ref(), |pair| {
        let here = index(&pair, 0.0)?;
        let base = index(&pair, 1.0)?;
        if !conflicted.has(&here) && base != here { pairs.push(&Array::of2(&here, &base)); }
        Ok(true)
    })?;
    Ok(pairs.into())
}

fn row(key: &JsValue, successors: &JsValue, relation: Option<JsValue>, orphan: bool) -> Result<JsValue> {
    let result: JsValue = Object::new().into();
    set(&result, "key", key)?;
    set(&result, "successors", successors)?;
    if let Some(relation) = relation { set(&result, "relation", &relation)?; }
    set(&result, "orphan", &orphan.into())?;
    Ok(result)
}

fn split_successors(entry: &JsValue, policy: &str) -> Result<JsValue> {
    if policy == "copy-to-all" { return Ok(copy(&get(entry, "head")?)?.into()); }
    if policy != "largest-share" || !truthy(&get(entry, "shares")?)
        || length(entry, "shares")? != length(entry, "head")? {
        return Ok(Array::new().into());
    }
    // Preserve #8084: this helper does not validate shares. NaN, negative,
    // infinite, empty and tied shares keep the original comparison behavior.
    let mut best = 0.0;
    let mut i = 1.0;
    while less(&i.into(), &length(entry, "shares")?)? {
        let candidate = index(&get(entry, "shares")?, i)?;
        let previous = index(&get(entry, "shares")?, best)?;
        if greater(&candidate, &previous)? { best = i; }
        i += 1.0;
    }
    let shares = get(entry, "shares")?;
    let captured = entry.clone();
    let tied = method_predicate(&shares, "filter", move |share| {
        Ok(share == index(&get(&captured, "shares")?, best)?)
    })?;
    if greater(&len(&tied)?, &1.0.into())? { Ok(Array::new().into()) }
    else { Ok(Array::of1(&index(&get(entry, "head")?, best)?).into()) }
}

pub fn rekey(keys: &JsValue, entries: &JsValue, deleted: &JsValue, policy: &str) -> Result<JsValue> {
    let removed = Set::new(&JsValue::UNDEFINED);
    visit(deleted, |key| { removed.add(&key); Ok(true) })?;
    let by_base = Map::new();
    visit(entries, |entry| {
        visit(&get(&entry, "base")?, |key| {
            if !by_base.has(&key) { by_base.set(&key, &entry); }
            Ok(true)
        })?;
        Ok(true)
    })?;
    let results = Array::new();
    visit(keys, |key| {
        let entry = by_base.get(&key);
        let result = if !truthy(&entry) {
            if removed.has(&key) { row(&key, Array::new().as_ref(), None, true)? }
            else { row(&key, Array::of1(&key).as_ref(), Some("unchanged".into()), false)? }
        } else if !equal(&get(&entry, "relation")?, "split") {
            let successors = copy(&get(&entry, "head")?)?;
            row(&key, successors.as_ref(), Some(get(&entry, "relation")?), false)?
        } else {
            let successors = split_successors(&entry, policy)?;
            let orphan = len(&successors)? == JsValue::from_f64(0.0);
            row(&key, &successors, Some("split".into()), orphan)?
        };
        results.push(&result);
        Ok(true)
    })?;
    Ok(results.into())
}
