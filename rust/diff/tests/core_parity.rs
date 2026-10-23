// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::collections::HashMap;
use ifc_lite_diff::{key_diff::diff_by_key, model::*};
use serde_json::{json, Value};
use ifc_lite_diff::{content_match::apply_content_matching, content_types::*, geometry_compare::GeometryTolerances};

fn string(value: &Value, key: &str) -> String { value[key].as_str().unwrap().to_owned() }
fn optional(value: &Value, key: &str) -> Option<String> { value[key].as_str().map(str::to_owned) }
fn entity(value: &Value) -> EntityFingerprint<Value> {
    EntityFingerprint {
        key: string(value, "key"), ifc_type: string(value, "ifcType"), data_hash: string(value, "dataHash"),
        geometry_hash: optional(value, "geometryHash"), aabb: value.get("aabb").map(|aabb| EntityAabb {
            min: std::array::from_fn(|axis| aabb["min"][axis].as_f64().unwrap()),
            max: std::array::from_fn(|axis| aabb["max"][axis].as_f64().unwrap()),
        }), volume: value["volume"].as_f64(),
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

fn content_match(value: &ContentMatch<'_, Value>) -> Value {
    let kind = match value.kind {
        ContentMatchKind::Renamed => "renamed", ContentMatchKind::Moved => "moved",
        ContentMatchKind::Reshaped => "reshaped", ContentMatchKind::Respecified => "respecified",
        ContentMatchKind::Duplicated => "duplicated", ContentMatchKind::Deduplicated => "deduplicated",
        ContentMatchKind::Ambiguous => "ambiguous",
    };
    let tier = match value.tier {
        ContentMatchTier::GeometryHash => "geometry-hash", ContentMatchTier::GeometryOnly => "geometry-only",
        ContentMatchTier::ResidueOneToOne => "residue-1-1", ContentMatchTier::Positional => "positional",
        ContentMatchTier::Unresolved => "unresolved",
    };
    let mut result = json!({ "kind": kind, "tier": tier, "dataHash": value.data_hash,
        "base": value.base.iter().map(|entity| &entity.reference).collect::<Vec<_>>(),
        "head": value.head.iter().map(|entity| &entity.reference).collect::<Vec<_>>() });
    if let Some(hash) = &value.geometry_hash { result["geometryHash"] = json!(hash); }
    if let Some(keys) = &value.changed_components { result["changedComponents"] = json!(keys); }
    if let Some(distance) = value.distance {
        // Match JSON.stringify's number representation (1.0 -> 1), without
        // relaxing numerical equality or rounding a comparison result.
        result["distance"] = if distance.is_finite() {
            serde_json::from_str(ryu_js::Buffer::new().format(distance)).unwrap()
        } else { Value::Null };
    }
    result
}

fn split_claim(value: &ifc_lite_diff::split_types::SplitMergeClaim<'_, Value>) -> Value {
    use ifc_lite_diff::split_types::*;
    let kind = match value.kind { SplitMergeKind::Split => "split", SplitMergeKind::Merge => "merge" };
    let confidence = match value.confidence { SplitConfidence::Verified => "verified", SplitConfidence::Extent => "extent", SplitConfidence::Displaced => "displaced" };
    let mut result = json!({"kind":kind, "confidence":confidence, "whole":value.whole.reference,
        "pieces":value.pieces.iter().map(|p| &p.reference).collect::<Vec<_>>()});
    for (key, number) in [("wholeVolume",value.whole_volume),("piecesVolume",value.pieces_volume),("volumeResidual",value.volume_residual)] {
        if let Some(number) = number {
            result[key] = if number.is_finite() { serde_json::from_str(ryu_js::Buffer::new().format(number)).unwrap() } else { Value::Null };
        }
    }
    if let Some(excluded) = value.excluded { result["excluded"] = excluded.reference.clone(); }
    if value.cross_class { result["crossClass"] = json!(true); }
    result
}

fn run_vectors(file: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(file);
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
        let core = diff_by_key(&base, &head, &options);
        let (result, content_matches) = if raw_options["matchUnpairedByContent"] == true {
            let tolerances = GeometryTolerances::resolve(raw_options["moveTolerance"].as_f64(),
                raw_options["reshapeTolerance"].as_f64(), raw_options["maxMoveDistance"].as_f64());
            let matched = apply_content_matching(core, tolerances);
            let matches: Vec<_> = matched.content_matches.iter().map(content_match).collect();
            (matched.core, Some(matches))
        } else { (core, None) };
        let split_claims = if raw_options["detectSplitMerge"] == true {
            let settings = ifc_lite_diff::split_types::SplitSettings::resolve(raw_options["splitVolumeTolerance"].as_f64(),
                raw_options["splitPaddingMin"].as_f64(), raw_options["splitPaddingRatio"].as_f64(), raw_options["maxSplitPieces"].as_f64());
            let families: Option<Vec<Vec<String>>> = raw_options.get("classFamilies").map(|v| serde_json::from_value(v.clone()).unwrap());
            ifc_lite_diff::split_merge::detect_split_merge(&result.entries, result.use_geometry, settings, families.as_deref())
                .map(|claims| claims.iter().map(split_claim).collect::<Vec<_>>())
        } else { None };
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
        if let Some(matches) = content_matches { actual["contentMatches"] = json!(matches); }
        if let Some(claims) = split_claims { actual["splitMerges"] = json!(claims); }
        assert_eq!(actual, vector["expected"], "case {}", vector["name"]);
    }
}

#[test]
fn key_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("core_vectors.json"); }
#[test]
fn content_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("content_vectors.json"); }

#[test]
fn split_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("split_vectors.json"); }
