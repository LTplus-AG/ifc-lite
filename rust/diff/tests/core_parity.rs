// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::collections::HashMap;
use ifc_lite_diff::{key_diff::diff_by_key, model::*};
use serde_json::{json, Value};

fn string(value: &Value, key: &str) -> String { value[key].as_str().unwrap().to_owned() }
fn optional(value: &Value, key: &str) -> Option<String> { value[key].as_str().map(str::to_owned) }
fn entity(value: &Value) -> EntityFingerprint<Value> {
    EntityFingerprint {
        key: string(value, "key"), ifc_type: string(value, "ifcType"), data_hash: string(value, "dataHash"),
        geometry_hash: optional(value, "geometryHash"), aabb: None, volume: None,
        components: value["components"].as_object().map(|map| map.iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())).collect()),
        container: optional(value, "container"), reference: value.clone(),
    }
}
fn scope(value: &Value) -> DiffScope {
    match value.as_str() { Some("data") => DiffScope::Data, Some("geometry") => DiffScope::Geometry, _ => DiffScope::Both }
}
fn entry(entry: &DiffEntry<'_, Value>) -> Value {
    let state = match entry.state {
        DiffState::Added => "added", DiffState::Modified => "modified",
        DiffState::Deleted => "deleted", DiffState::Unchanged => "unchanged",
    };
    let changes: Vec<_> = entry.change_kinds.iter().map(|kind| match kind {
        DiffChangeKind::Data => "data", DiffChangeKind::Geometry => "geometry", DiffChangeKind::Container => "container",
    }).collect();
    let mut result = json!({"key": entry.key, "state": state, "changeKinds": changes});
    if let Some(base) = entry.base { result["base"] = base.reference.clone(); }
    if let Some(head) = entry.head { result["head"] = head.reference.clone(); }
    if let Some(keys) = &entry.changed_components { result["changedComponents"] = json!(keys); }
    result
}

#[test]
fn key_pass_matches_typescript_field_by_field_issue_8042() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/core_vectors.json");
    let vectors: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path)
        .expect("generate the committed corpus with node scripts/diff-core-vectors.mjs")).unwrap();
    for vector in vectors {
        let base: Vec<_> = vector["base"].as_array().unwrap().iter().map(entity).collect();
        let head: Vec<_> = vector["head"].as_array().unwrap().iter().map(entity).collect();
        let raw_options = &vector["options"];
        let options = KeyDiffOptions {
            scope: scope(&raw_options["scope"]),
            exclude_types: raw_options["excludeTypes"].as_array().map(|values| values.iter()
                .map(|value| value.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
            key_aliases: raw_options["keyAliases"].as_array().map(|pairs| pairs.iter()
                .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned()))
                .collect::<HashMap<_, _>>()),
        };
        let result = diff_by_key(&base, &head, &options);
        let entries: Vec<_> = result.entries.iter().map(entry).collect();
        // JS Map iteration follows entries, while Rust stores lookup indices.
        let by_key: Vec<_> = result.entries.iter().map(|item| {
            let index = result.by_key[&item.key];
            json!([item.key, entries[index]])
        }).collect();
        let mut actual = json!({
            "scope": match result.scope { DiffScope::Data => "data", DiffScope::Geometry => "geometry", DiffScope::Both => "both" },
            "excludedTypes": result.excluded_types, "entries": entries, "byKey": by_key,
            "counts": { "added": result.counts.added, "modified": result.counts.modified,
                "deleted": result.counts.deleted, "unchanged": result.counts.unchanged },
        });
        if let Some(aliases) = result.applied_key_aliases { actual["appliedKeyAliases"] = json!(aliases); }
        assert_eq!(actual, vector["expected"], "case {}", vector["name"]);
    }
}
