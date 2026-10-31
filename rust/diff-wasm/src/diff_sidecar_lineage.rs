// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Lineage validation over live values. The access sequence mirrors the oracle.
use crate::diff_sidecar_host::*;
use js_sys::{Array, Set};
use wasm_bindgen::prelude::*;
fn string_list(value: &JsValue) -> Result<bool> {
    Ok(array(value)?
        && truthy(&method_predicate(value, "every", |v| {
            Ok(v.is_string() && len(&v)? != JsValue::from_f64(0.0))
        })?))
}
fn valid_relation(value: &JsValue) -> bool {
    ["identity", "split", "merge", "replaced"]
        .iter()
        .any(|s| equal(value, s))
}
fn length(entry: &JsValue, side: &str) -> Result<JsValue> {
    len(&get(entry, side)?)
}
fn entry_problem(entry: &JsValue) -> Result<Option<JsValue>> {
    let problem = if !record(entry)? {
        "entries must be { base[], head[], relation, reason, shares? } objects"
    } else if !string_list(&get(entry, "base")?)? || !string_list(&get(entry, "head")?)? {
        "entries must carry non-empty string lists for base and head"
    } else if length(entry, "base")? == JsValue::from_f64(0.0)
        || length(entry, "head")? == JsValue::from_f64(0.0)
    {
        "an entry must name at least one key on each side"
    } else if !get(entry, "relation")?.is_string() || !valid_relation(&get(entry, "relation")?) {
        "entries must carry a relation of identity | split | merge | replaced"
    } else if !get(entry, "reason")?.is_string() {
        "entries must carry a string reason"
    } else {
        return cardinality(entry);
    };
    Ok(Some(problem.into()))
}
fn cardinality(entry: &JsValue) -> Result<Option<JsValue>> {
    let relation = get(entry, "relation")?;
    let one = JsValue::from_f64(1.0);
    if (equal(&relation, "identity") || equal(&relation, "replaced"))
        && (length(entry, "base")? != one || length(entry, "head")? != one)
    {
        return Ok(Some(message(&[
            "a ".into(),
            text(&relation)?,
            " entry must be 1:1".into(),
        ])?));
    }
    if equal(&relation, "split") && length(entry, "base")? != one {
        return Ok(Some("a split entry must have exactly one base key".into()));
    }
    if equal(&relation, "merge") && length(entry, "head")? != one {
        return Ok(Some("a merge entry must have exactly one head key".into()));
    }
    if !get(entry, "shares")?.is_undefined() {
        let expected = if equal(&relation, "split") {
            length(entry, "head")?
        } else if equal(&relation, "merge") {
            length(entry, "base")?
        } else {
            JsValue::from_f64(-1.0)
        };
        if !array(&get(entry, "shares")?)?
            || len(&get(entry, "shares")?)? != expected
            || !truthy(&method_value(&get(entry, "shares")?, "every", |share| {
                if share.as_f64().is_none() { return Ok(JsValue::FALSE); }
                let checked = finite(&share)?;
                if !truthy(&checked) { Ok(checked) }
                else { Ok(greater_equal(&share, &0.0.into())?.into()) }
            })?)
        {
            return Ok(Some("shares must be one finite non-negative number per key on the k side of a split or merge".into()));
        }
    }
    Ok(None)
}
fn conflicts(entries: &JsValue, errors: &Array) -> Result<()> {
    for side in ["base", "head"] {
        let seen = Set::new(&JsValue::UNDEFINED);
        let repeated = Set::new(&JsValue::UNDEFINED);
        visit(entries, |entry| {
            visit(&get(&entry, side)?, |key| {
                if seen.has(&key) {
                    repeated.add(&key);
                }
                seen.add(&key);
                Ok(true)
            })?;
            Ok(true)
        })?;
        for key in sorted(&repeated)?.iter() {
            push_message(
                errors,
                &format!("{side} key \""),
                &key,
                "\" appears in more than one lineage entry",
            )?;
        }
    }
    Ok(())
}
pub fn validate(value: &JsValue, errors: &Array) -> Result<()> {
    if !array(&get(value, "entries")?)? {
        errors.push(&"entries must be an array".into());
    } else {
        let mut shaped = true;
        visit(&get(value, "entries")?, |entry| {
            if let Some(problem) = entry_problem(&entry)? {
                errors.push(&problem);
                shaped = false;
                return Ok(false);
            }
            Ok(true)
        })?;
        if shaped {
            conflicts(&get(value, "entries")?, errors)?;
        }
    }
    if !string_list(&get(value, "deleted")?)? {
        errors.push(&"deleted must be a list of non-empty strings".into());
    } else if array(&get(value, "entries")?)? {
        let in_entries = Set::new(&JsValue::UNDEFINED);
        visit(&get(value, "entries")?, |entry| {
            let base = if entry.is_null() || entry.is_undefined() {
                JsValue::UNDEFINED
            } else {
                get(&entry, "base")?
            };
            if array(&base)? {
                visit(&get(&entry, "base")?, |key| {
                    in_entries.add(&key);
                    Ok(true)
                })?;
            }
            Ok(true)
        })?;
        // Custom filter can retain its callback on an object key in this Set.
        // Keep the Set in the JS graph; the Rust predicate captures no input.
        let both = method_context_predicate(
            &get(value, "deleted")?, "filter", in_entries.as_ref(),
            |context, key| Ok(context.unchecked_into::<Set>().has(&key)),
        )?;
        let both = sort_result(&both, |a, b| compare(&a, &b))?;
        visit(&both, |key| {
            push_message(
                errors,
                "deleted key \"",
                &key,
                "\" also appears in a lineage entry",
            )?;
            Ok(true)
        })?;
    }
    Ok(())
}
