// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{JsString, columns::{decode_columns, FingerprintColumns, ABSENT_STRING},
    engine::{diff_models, DiffOptions}, lineage::{self, Lineage, LineageEntry, LineageRelation, RekeyPolicy},
    model::{DiffState, KeyDiffOptions}, key_diff::diff_by_key,
    sidecar_document::{parse_ordered_json, serialize_sidecar},
    transport_options::options_from_document, transport_result::result_to_document};
fn distinct() -> Vec<JsString> {
    vec![JsString::from_units(vec![0xd800]), JsString::from_units(vec![0xdc00]),
        "�".into(), "\\ud800".into(), "𐀀".into(), "\u{e000}".into()]
}
fn columns(strings: Vec<JsString>) -> FingerprintColumns {
    let count = strings.len();
    FingerprintColumns { strings, fields: (0..count).flat_map(|i| [i as u32, i as u32, i as u32, ABSENT_STRING, i as u32]).collect(),
        flags: vec![4; count], boxes: vec![0.0; count * 6], volumes: vec![0.0; count],
        component_offsets: (0..=count as u32).collect(),
        component_pairs: (0..count as u32).flat_map(|i| [i, i]).collect() }
}
#[test]
fn issue_8042_columns_diff_and_result_do_not_merge_distinct_js_strings() {
    let strings = distinct();
    let base = decode_columns(columns(strings.clone())).unwrap();
    let mut head = decode_columns(columns(strings.clone())).unwrap();
    for entity in &mut head {
        entity.components.as_mut().unwrap().insert(entity.key.clone(), "changed".into());
    }
    let options = DiffOptions::default();
    let result = result_to_document(&diff_models(&base, &head, &options));
    let rows = result["entries"].as_array().unwrap();
    assert_eq!(rows.len(), strings.len());
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row["key"].as_string(), Some(&strings[i]));
        assert_eq!(row["changedComponents"][0].as_string(), Some(&strings[i]));
        assert_eq!(base[i].container.as_ref(), Some(&strings[i]));
        assert_eq!(base[i].ifc_type, strings[i]);
        assert_eq!(base[i].data_hash, strings[i]);
    }
    let wire = serialize_sidecar(&result);
    assert_eq!(parse_ordered_json(&wire).unwrap(), result);
}
#[test]
fn issue_8042_aliases_exclusions_and_class_families_use_lossless_strings() {
    let strings = distinct();
    let base = decode_columns(columns(vec![strings[0].clone()])).unwrap();
    let mut head = decode_columns(columns(vec![strings[1].clone()])).unwrap();
    head[0].ifc_type = base[0].ifc_type.clone();
    head[0].data_hash = base[0].data_hash.clone();
    head[0].container = base[0].container.clone();
    let options = options_from_document(&parse_ordered_json(r#"{"keyAliases":[["\udc00","\ud800"]],"classFamilies":[["\ud800","\udc00"]]}"#).unwrap());
    let diff = diff_models(&base, &head, &options);
    assert_eq!(diff.core.entries.len(), 1);
    assert_eq!(diff.core.entries[0].state, DiffState::Unchanged);
    assert_eq!(diff.core.entries[0].head.unwrap().key, strings[1]);
    assert_eq!(options.class_families.unwrap()[0], strings[..2]);
    let options = KeyDiffOptions { exclude_types: vec![strings[0].clone()], ..Default::default() };
    assert!(diff_by_key(&base, &head, &options).entries.is_empty());
    let options = KeyDiffOptions { exclude_types: vec!["�".into()], ..Default::default() };
    assert_eq!(diff_by_key(&base, &head, &options).entries.len(), 2);
}
#[test]
fn issue_8042_lineage_keys_reasons_conflicts_and_deleted_are_lossless() {
    let strings = distinct();
    let entry = LineageEntry { base: vec![strings[0].clone()], head: vec![strings[1].clone()],
        reason: strings[0].clone(), relation: LineageRelation::Identity, shares: None };
    let entries = vec![entry.clone(), entry];
    let conflicts = lineage::lineage_conflicts(&entries);
    assert_eq!(conflicts[0], JsString::surround("base key \"", &strings[0], "\" appears in more than one lineage entry"));
    assert_eq!(conflicts[1], JsString::surround("head key \"", &strings[1], "\" appears in more than one lineage entry"));
    let aliases = lineage::key_aliases_from_lineage(&entries);
    assert_eq!(aliases, vec![(strings[1].clone(), strings[0].clone())]);
    let lineage = Lineage { entries, deleted: vec![strings[2].clone()] };
    let rows = lineage::rekey_by_lineage(&strings, &lineage, RekeyPolicy::CopyToAll);
    assert_eq!(rows[0].successors, vec![strings[1].clone()]);
    assert!(rows[2].orphan);
    assert_eq!(rows[3].successors, vec![strings[3].clone()]);
}
