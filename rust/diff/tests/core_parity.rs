// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#[path = "fixtures/lineage_assertions.rs"]
mod lineage_assertions;
#[path = "fixtures/transport_assertions.rs"]
mod transport_assertions;
use std::collections::HashMap;
use ifc_lite_diff::JsString;
use ifc_lite_diff::model::*;
use serde_json::{json, Value};
use ifc_lite_diff::{content_types::*, geometry_compare::GeometryTolerances};

fn string(value: &Value, key: &str) -> JsString { value[key].as_str().unwrap().into() }
fn optional(value: &Value, key: &str) -> Option<JsString> { value[key].as_str().map(Into::into) }
fn entity(value: &Value) -> EntityFingerprint<Value> {
    EntityFingerprint {
        key: string(value, "key"), ifc_type: string(value, "ifcType"), data_hash: string(value, "dataHash"),
        geometry_hash: optional(value, "geometryHash"), aabb: value.get("aabb").map(|aabb| EntityAabb {
            min: std::array::from_fn(|axis| aabb["min"][axis].as_f64().unwrap()),
            max: std::array::from_fn(|axis| aabb["max"][axis].as_f64().unwrap()),
        }), volume: value["volume"].as_f64(),
        components: value["components"].as_object().map(|map| map.iter()
            .map(|(key, value)| (key.as_str().into(), value.as_str().unwrap().into())).collect()),
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

fn successor_claim(value: &ifc_lite_diff::successor::SuccessorClaim<'_, Value>) -> Value {
    use ifc_lite_diff::successor::SuccessorConfidence;
    let confidence = match value.confidence { SuccessorConfidence::Footprint => "footprint", SuccessorConfidence::Position => "position" };
    let number = |v: f64| if v.is_finite() { serde_json::from_str(ryu_js::Buffer::new().format(v)).unwrap() } else { Value::Null };
    let mut result = json!({"confidence":confidence,"base":value.base.reference,"head":value.head.reference,
        "overlap":number(value.overlap),"distance":number(value.distance)});
    if let Some(keys) = &value.agreeing_components { result["agreeingComponents"] = json!(keys); }
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
        transport_assertions::assert_transport(&vector);
        let raw_options = &vector["options"];
        let options = KeyDiffOptions {
            scope: scope(&raw_options["scope"]),
            exclude_types: raw_options["excludeTypes"].as_array().map(|values| values.iter()
                .map(|value| value.as_str().unwrap().into()).collect()).unwrap_or_default(),
            key_aliases: raw_options["keyAliases"].as_array().map(|pairs| pairs.iter()
                .map(|pair| (pair[0].as_str().unwrap().into(), pair[1].as_str().unwrap().into()))
                .collect::<HashMap<_, _>>()),
        };
        let options = ifc_lite_diff::engine::DiffOptions {
            key: options,
            geometry: GeometryTolerances::resolve(raw_options["moveTolerance"].as_f64(), raw_options["reshapeTolerance"].as_f64(), raw_options["maxMoveDistance"].as_f64()),
            match_unpaired_by_content: raw_options["matchUnpairedByContent"] == true,
            detect_split_merge: raw_options["detectSplitMerge"] == true,
            detect_successors: raw_options["detectSuccessors"] == true,
            split: ifc_lite_diff::split_types::SplitSettings::resolve(raw_options["splitVolumeTolerance"].as_f64(),raw_options["splitPaddingMin"].as_f64(),raw_options["splitPaddingRatio"].as_f64(),raw_options["maxSplitPieces"].as_f64()),
            successor: ifc_lite_diff::successor::SuccessorSettings::resolve(raw_options["successorOverlap"].as_f64(),raw_options["successorDistance"].as_f64()),
            class_families: raw_options.get("classFamilies").map(|v|serde_json::from_value(v.clone()).unwrap()),
        };
        let diff = ifc_lite_diff::engine::diff_models(&base,&head,&options);
        let result = diff.core;
        let content_matches = diff.content_matches;
        let split_claims = diff.split_merges;
        let successors = diff.successors;
        lineage_assertions::assert_lineage(&vector, &result, content_matches.as_deref().unwrap_or(&[]), split_claims.as_deref().unwrap_or(&[]), successors.as_deref().unwrap_or(&[]));
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
        if let Some(matches) = content_matches { actual["contentMatches"] = json!(matches.iter().map(content_match).collect::<Vec<_>>()); }
        if let Some(claims) = split_claims { actual["splitMerges"] = json!(claims.iter().map(split_claim).collect::<Vec<_>>()); }
        if let Some(claims) = successors { actual["successors"] = json!(claims.iter().map(successor_claim).collect::<Vec<_>>()); }
        assert_eq!(actual, vector["expected"], "case {}", vector["name"]);
    }
}

#[test]
fn key_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("core_vectors.json"); }
#[test]
fn content_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("content_vectors.json"); }

#[test]
fn split_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("split_vectors.json"); }

#[test]
fn successor_pass_matches_typescript_field_by_field_issue_8042() { run_vectors("successor_vectors.json"); }

#[test]
fn lineage_matches_typescript_field_by_field_issue_8042() { run_vectors("lineage_vectors.json"); }
