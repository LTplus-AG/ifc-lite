// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The GlobalId classification pass, before optional content matching (#8042).
use std::collections::{HashMap, HashSet};
use crate::model::*;
use crate::projections::is_ecmascript_whitespace;
use crate::utf16::cmp_code_units;

fn normalize_type(value: &str) -> String {
    value.trim_matches(is_ecmascript_whitespace).to_uppercase()
}

fn index<R>(entities: &[EntityFingerprint<R>]) -> Vec<(String, usize)> {
    let mut seen = HashSet::new();
    entities.iter().enumerate()
        .filter(|(_, entity)| seen.insert(entity.key.as_str()))
        .map(|(i, entity)| (entity.key.clone(), i)).collect()
}

fn resolve_aliases(
    base: &[(String, usize)], head: &mut [(String, usize)],
    aliases: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let base_keys: HashSet<_> = base.iter().map(|(key, _)| key.as_str()).collect();
    let head_keys: HashSet<_> = head.iter().map(|(key, _)| key.as_str()).collect();
    let mut proposals = Vec::new();
    let mut claims = HashMap::<&str, usize>::new();
    for (key, _) in head.iter() {
        let Some(target) = aliases.get(key) else { continue };
        if target.is_empty() || target == key || !base_keys.contains(target.as_str())
            || head_keys.contains(target.as_str()) { continue; }
        proposals.push((key.clone(), target.clone()));
        *claims.entry(target.as_str()).or_default() += 1;
    }
    let applied: Vec<_> = proposals.into_iter()
        .filter(|(_, target)| claims[target.as_str()] == 1).collect();
    let replacements: HashMap<_, _> = applied.iter().map(|(key, value)| (key, value)).collect();
    for (key, _) in head.iter_mut() {
        if let Some(target) = replacements.get(key) { *key = (*target).clone(); }
    }
    applied
}

fn changed_components(base: &HashMap<String, String>, head: &HashMap<String, String>) -> Vec<String> {
    let mut keys: Vec<_> = base.keys().chain(head.keys()).collect::<HashSet<_>>()
        .into_iter().filter(|key| base.get(*key) != head.get(*key)).cloned().collect();
    keys.sort_by(|a, b| cmp_code_units(a, b));
    keys
}

/// The key pass is reusable by the subsequent content stages. Its output order
/// follows JS Map insertion order: first base appearances, then head-only keys.
pub fn diff_by_key<'a, R>(
    base: &'a [EntityFingerprint<R>], head: &'a [EntityFingerprint<R>], options: &KeyDiffOptions,
) -> KeyDiff<'a, R> {
    let excluded: HashSet<String> = options.exclude_types.iter().map(|name| normalize_type(name))
        .filter(|name| !name.is_empty()).collect();
    let is_excluded = |entity: &EntityFingerprint<R>| !excluded.is_empty() && excluded.contains(&normalize_type(&entity.ifc_type));
    let base_order = index(base);
    let mut head_order = index(head);
    let applied_key_aliases = options.key_aliases.as_ref()
        .map(|aliases| resolve_aliases(&base_order, &mut head_order, aliases));
    let base_index: HashMap<_, _> = base_order.iter().map(|(key, i)| (key.as_str(), *i)).collect();
    let head_index: HashMap<_, _> = head_order.iter().map(|(key, i)| (key.as_str(), *i)).collect();
    let base_has_geometry = base_order.iter().any(|(key, i)| {
        base[*i].geometry_hash.is_some() && !is_excluded(&base[*i])
            && head_index.get(key.as_str()).is_none_or(|j| !is_excluded(&head[*j]))
    });
    let head_has_geometry = head_order.iter().any(|(key, i)| {
        head[*i].geometry_hash.is_some() && !is_excluded(&head[*i])
            && base_index.get(key.as_str()).is_none_or(|j| !is_excluded(&base[*j]))
    });
    let consider_data = options.scope != DiffScope::Geometry;
    let use_geometry = options.scope != DiffScope::Data && base_has_geometry == head_has_geometry;
    let mut entries = Vec::new();
    for (key, i) in &base_order {
        let base_entity = &base[*i];
        let head_entity = head_index.get(key.as_str()).map(|j| &head[*j]);
        if is_excluded(base_entity) || head_entity.is_some_and(&is_excluded) { continue; }
        let mut entry = DiffEntry {
            key: key.clone(), state: DiffState::Deleted, change_kinds: Vec::new(),
            base: Some(base_entity), head: head_entity, changed_components: None,
        };
        if let Some(other) = head_entity {
            if consider_data && (base_entity.ifc_type != other.ifc_type || base_entity.data_hash != other.data_hash) {
                entry.change_kinds.push(DiffChangeKind::Data);
            }
            if use_geometry && base_entity.geometry_hash != other.geometry_hash {
                entry.change_kinds.push(DiffChangeKind::Geometry);
            }
            if consider_data {
                if let (Some(a), Some(b)) = (&base_entity.container, &other.container) {
                    if !a.is_empty() && !b.is_empty() && a != b {
                        entry.change_kinds.push(DiffChangeKind::Container);
                    }
                }
            }
            if let (Some(a), Some(b)) = (&base_entity.components, &other.components) {
                entry.changed_components = Some(changed_components(a, b));
            }
            entry.state = if entry.change_kinds.is_empty() { DiffState::Unchanged } else { DiffState::Modified };
        }
        entries.push(entry);
    }
    for (key, i) in &head_order {
        if base_index.contains_key(key.as_str()) || is_excluded(&head[*i]) { continue; }
        entries.push(DiffEntry {
            key: key.clone(), state: DiffState::Added, change_kinds: Vec::new(),
            base: None, head: Some(&head[*i]), changed_components: None,
        });
    }
    let mut counts = DiffCounts::default();
    let mut by_key = HashMap::new();
    for (i, entry) in entries.iter().enumerate() {
        by_key.insert(entry.key.clone(), i);
        match entry.state {
            DiffState::Added => counts.added += 1,
            DiffState::Modified => counts.modified += 1,
            DiffState::Deleted => counts.deleted += 1,
            DiffState::Unchanged => counts.unchanged += 1,
        }
    }
    let mut excluded_types: Vec<_> = excluded.into_iter().collect();
    excluded_types.sort_by(|a, b| cmp_code_units(a, b));
    KeyDiff { scope: options.scope, excluded_types, entries, by_key, counts, applied_key_aliases, use_geometry }
}

#[cfg(test)]
#[path = "key_diff_tests.rs"]
mod tests;
