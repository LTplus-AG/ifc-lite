// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Structural validation of untrusted sidecar JSON. The host supplies its date
//! parser predicate: the JS facade uses Date.parse, including legacy formats.
use std::collections::{HashMap, HashSet};
use serde_json::Value;
use crate::projections::is_ecmascript_whitespace;
use crate::utf16::cmp_code_units;

fn string_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty())))
}
fn common(value: &Value, lineage: bool, valid_date: &impl Fn(&str) -> bool) -> Vec<String> {
    let mut errors = vec![];
    let format = if lineage { "ifc-lite/lineage" } else { "ifc-lite/identity-map" };
    if value["format"] != format { errors.push(format!("format must be \"{format}\"")); }
    let version = value["version"].as_f64();
    if version != Some(1.0) && version != Some(2.0) { errors.push("version must be 1 or 2".into()); }
    else if lineage {
        if version == Some(2.0) && value.get("keyProperty").is_none() { errors.push("version 2 requires keyProperty".into()); }
    } else if value.get("keyProperty").is_some() != (version == Some(2.0)) {
        errors.push("version 2 requires keyProperty and version 1 forbids it".into());
    }
    for side in ["base","head"] {
        let v = &value[side];
        if !v.is_object() { errors.push(format!("{side} must be {{ hash, path? }}")); continue; }
        if v["hash"].as_str().is_none_or(|s| s.is_empty()) { errors.push(format!("{side}.hash must be a non-empty content digest")); }
        if v.get("path").is_some_and(|v| !v.is_string()) { errors.push(format!("{side}.path must be a string when present")); }
    }
    if let Some(created) = value.get("created") {
        if !created.as_str().is_some_and(valid_date) { errors.push("created must be an ISO 8601 timestamp when present".into()); }
    }
    if let Some(key) = value.get("keyProperty") {
        if key.as_str().is_none_or(|s| s.trim_matches(is_ecmascript_whitespace).is_empty()) {
            errors.push("keyProperty must be a non-empty string when present".into());
        }
    }
    errors
}
pub fn validate_identity_sidecar(value: &Value, valid_date: impl Fn(&str) -> bool) -> Vec<String> {
    if !value.is_object() { return vec!["sidecar must be an object".into()]; }
    let mut errors = common(value, false, &valid_date);
    let Some(entries) = value["entries"].as_array() else { errors.push("entries must be an array".into()); return errors; };
    let mut claimed = HashMap::new();
    let mut conflicts = HashSet::new();
    for entry in entries {
        if !entry.is_object() || !["base","here","reason"].iter().all(|k| entry[*k].is_string()) {
            errors.push("entries must be { base, here, reason } with string fields".into());
            return errors;
        }
        let base = entry["base"].as_str().unwrap();
        let here = entry["here"].as_str().unwrap();
        if let Some(previous) = claimed.get(here) {
            if *previous != base { conflicts.insert(here); }
        } else { claimed.insert(here,base); }
    }
    let mut conflicts: Vec<_> = conflicts.into_iter().collect();
    conflicts.sort_by(|a,b| cmp_code_units(a,b));
    errors.extend(conflicts.into_iter().map(|here| format!("entries claim two different base identities for here \"{here}\"")));
    errors
}
fn validate_lineage_entry(entry: &Value) -> Option<String> {
    let error = if !entry.is_object() { "entries must be { base[], head[], relation, reason, shares? } objects" }
    else if !string_list(&entry["base"]) || !string_list(&entry["head"]) { "entries must carry non-empty string lists for base and head" }
    else if entry["base"].as_array().unwrap().is_empty() || entry["head"].as_array().unwrap().is_empty() { "an entry must name at least one key on each side" }
    else if !matches!(entry["relation"].as_str(), Some("identity"|"split"|"merge"|"replaced")) { "entries must carry a relation of identity | split | merge | replaced" }
    else if !entry["reason"].is_string() { "entries must carry a string reason" }
    else {
        let base = entry["base"].as_array().unwrap().len();
        let head = entry["head"].as_array().unwrap().len();
        let relation = entry["relation"].as_str().unwrap();
        if matches!(relation,"identity"|"replaced") && (base != 1 || head != 1) { return Some(format!("a {relation} entry must be 1:1")); }
        if relation == "split" && base != 1 { return Some("a split entry must have exactly one base key".into()); }
        if relation == "merge" && head != 1 { return Some("a merge entry must have exactly one head key".into()); }
        if let Some(shares) = entry.get("shares") {
            let expected = match relation { "split"=>Some(head),"merge"=>Some(base),_=>None };
            if !shares.as_array().is_some_and(|a| Some(a.len()) == expected && a.iter().all(|v| v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))) {
                return Some("shares must be one finite non-negative number per key on the k side of a split or merge".into());
            }
        }
        return None;
    };
    Some(error.into())
}
pub fn validate_lineage_sidecar(value: &Value, valid_date: impl Fn(&str) -> bool) -> Vec<String> {
    if !value.is_object() { return vec!["sidecar must be an object".into()]; }
    let mut errors = common(value,true,&valid_date);
    if let Some(entries) = value["entries"].as_array() {
        if let Some(problem) = entries.iter().find_map(validate_lineage_entry) { errors.push(problem); }
        else {
            for side in ["base","head"] {
                let mut seen = HashSet::new(); let mut repeated = HashSet::new();
                for entry in entries { for key in entry[side].as_array().unwrap() {
                    let key = key.as_str().unwrap(); if !seen.insert(key) { repeated.insert(key); }
                } }
                let mut repeated: Vec<_> = repeated.into_iter().collect(); repeated.sort_by(|a,b|cmp_code_units(a,b));
                errors.extend(repeated.into_iter().map(|key|format!("{side} key \"{key}\" appears in more than one lineage entry")));
            }
        }
    } else { errors.push("entries must be an array".into()); }
    if !string_list(&value["deleted"]) { errors.push("deleted must be a list of non-empty strings".into()); }
    else if let Some(entries) = value["entries"].as_array() {
        let keys: HashSet<_> = entries.iter().flat_map(|e| e.get("base").and_then(Value::as_array).into_iter().flatten()).filter_map(Value::as_str).collect();
        let mut both: Vec<_> = value["deleted"].as_array().unwrap().iter().filter_map(Value::as_str).filter(|key|keys.contains(key)).collect();
        both.sort_by(|a,b|cmp_code_units(a,b));
        errors.extend(both.into_iter().map(|key|format!("deleted key \"{key}\" also appears in a lineage entry")));
    }
    errors
}
