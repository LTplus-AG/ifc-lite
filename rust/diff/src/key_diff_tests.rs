// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn entity(key: &str, data: &str, geometry: Option<&str>) -> EntityFingerprint<usize> {
    EntityFingerprint {
        key: key.into(), ifc_type: "IfcWall".into(), data_hash: data.into(),
        geometry_hash: geometry.map(Into::into), aabb: None, volume: None,
        components: None, container: None, reference: 42,
    }
}

#[test]
fn first_duplicate_wins_and_output_preserves_input_order_issue_8042() {
    let base = vec![entity("b", "old", None), entity("a", "same", None), entity("b", "new", None)];
    let head = vec![entity("a", "same", None), entity("c", "same", None), entity("b", "new", None)];
    let result = diff_by_key(&base, &head, &KeyDiffOptions::default());
    assert_eq!(result.entries.iter().map(|e| e.key.as_str().unwrap()).collect::<Vec<_>>(), ["b", "a", "c"]);
    assert_eq!(result.counts, DiffCounts { added: 1, modified: 1, deleted: 0, unchanged: 1 });
    assert!(std::ptr::eq(result.entries[0].base.unwrap(), &base[0]));
    assert_eq!(result.by_key[&crate::JsString::from("c")], 2);
    assert_eq!(result.applied_key_aliases, None);
}

#[test]
fn aliases_refuse_collisions_and_keep_entity_identity_issue_8042() {
    let base = vec![entity("a", "same", None)];
    let head = vec![entity("b", "same", None), entity("c", "same", None)];
    let mut options = KeyDiffOptions { key_aliases: Some(HashMap::from([
        ("b".into(), "a".into()), ("c".into(), "a".into()),
    ])), ..Default::default() };
    let result = diff_by_key(&base, &head, &options);
    assert_eq!(result.counts.added, 2);
    assert_eq!(result.counts.deleted, 1);
    assert_eq!(result.applied_key_aliases, Some(vec![]));
    options.key_aliases.as_mut().unwrap().remove(&crate::JsString::from("c"));
    let result = diff_by_key(&base, &head, &options);
    assert_eq!(result.counts.unchanged, 1);
    assert_eq!(result.entries[0].key, "a");
    assert_eq!(result.entries[0].head.unwrap().key, "b");
}

#[test]
fn geometry_abstention_ignores_excluded_hashes_issue_8042() {
    let base = vec![entity("a", "same", Some("1")), entity("b", "same", Some("2"))];
    let mut head = vec![entity("a", "same", None), entity("b", "same", Some("2"))];
    head[1].ifc_type = "IfcOpeningElement".into();
    let options = KeyDiffOptions { exclude_types: vec!["\u{FEFF} ifcopeningelement ".into()], ..Default::default() };
    let result = diff_by_key(&base, &head, &options);
    assert!(!result.use_geometry);
    assert_eq!(result.counts.unchanged, 1);
    assert_eq!(result.entries.len(), 1);
    assert_eq!(result.excluded_types, ["IFCOPENINGELEMENT"]);
}

#[test]
fn components_use_utf16_order_and_container_requires_two_nonempty_paths_issue_8042() {
    let mut base = vec![entity("a", "same", None)];
    let mut head = vec![entity("a", "same", None)];
    base[0].components = Some(HashMap::new());
    head[0].components = Some(HashMap::from([("\u{e000}".into(), "a".into()), ("\u{10000}".into(), "b".into())]));
    base[0].container = Some(crate::JsString::default());
    head[0].container = Some("Level 2".into());
    let options = KeyDiffOptions::default();
    let result = diff_by_key(&base, &head, &options);
    assert_eq!(result.entries[0].state, DiffState::Unchanged);
    assert_eq!(result.entries[0].changed_components, Some(vec!["\u{10000}".into(), "\u{e000}".into()]));
    base[0].container = Some("Level 1".into());
    assert_eq!(diff_by_key(&base, &head, &options).entries[0].change_kinds, [DiffChangeKind::Container]);
}

#[test]
fn issue_8042_component_walk_keeps_additions_deletions_and_equal_size_replacements() {
    // Exhaust all absent/first-value/second-value states for two keys on both
    // sides. Fixed expected key order is UTF-16, including astral-before-BMP.
    let keys: [JsString; 2] = ["\u{10000}".into(), "\u{e000}".into()];
    for mut encoding in 0..81 {
        let mut states = [0; 4];
        for state in &mut states { *state = encoding % 3; encoding /= 3; }
        let map = |states: &[usize]| keys.iter().zip(states).filter_map(|(key, state)| {
            match state { 0 => None, 1 => Some((key.clone(), "a".into())), _ => Some((key.clone(), "b".into())) }
        }).collect::<HashMap<_, _>>();
        let expected: Vec<_> = keys.iter().enumerate().filter(|(i, _)| states[*i] != states[*i + 2])
            .map(|(_, key)| key.clone()).collect();
        assert_eq!(changed_components(&map(&states[..2]), &map(&states[2..])), expected);
    }
}
