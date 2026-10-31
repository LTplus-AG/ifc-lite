// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The GlobalId classification pass, before optional content matching (#8042).
use crate::JsString;
use std::collections::{HashMap, HashSet};
use crate::model::*;
use crate::utf16::cmp_code_units;

fn normalize_type(value: &JsString) -> JsString {
    value.normalized_class()
}

type KeyIndex<'a> = HashMap<&'a JsString, usize, crate::JsHash>;

fn index<R>(entities: &[EntityFingerprint<R>]) -> (Vec<(JsString, usize)>, KeyIndex<'_>) {
    let mut lookup = HashMap::with_capacity_and_hasher(entities.len(), crate::JsHash);
    let mut order = Vec::with_capacity(entities.len());
    for (i, entity) in entities.iter().enumerate() {
        if let std::collections::hash_map::Entry::Vacant(slot) = lookup.entry(&entity.key) {
            slot.insert(i);
            order.push((entity.key.clone(), i));
        }
    }
    (order, lookup)
}

fn resolve_aliases(
    base: &[(JsString, usize)], head: &mut [(JsString, usize)],
    aliases: &HashMap<JsString, JsString>,
) -> Vec<(JsString, JsString)> {
    let base_keys: HashSet<_> = base.iter().map(|(key, _)| key).collect();
    let head_keys: HashSet<_> = head.iter().map(|(key, _)| key).collect();
    let mut proposals = Vec::new();
    let mut claims = HashMap::<&JsString, usize>::new();
    for (key, _) in head.iter() {
        let Some(target) = aliases.get(key) else { continue };
        if target.is_empty() || target == key || !base_keys.contains(target)
            || head_keys.contains(target) { continue; }
        proposals.push((key.clone(), target.clone()));
        *claims.entry(target).or_default() += 1;
    }
    let applied: Vec<_> = proposals.into_iter()
        .filter(|(_, target)| claims[target] == 1).collect();
    let replacements: HashMap<_, _> = applied.iter().map(|(key, value)| (key, value)).collect();
    for (key, _) in head.iter_mut() {
        if let Some(target) = replacements.get(key) { *key = (*target).clone(); }
    }
    applied
}

pub(crate) fn changed_components(base: &ComponentMap, head: &ComponentMap) -> Vec<JsString> {
    // #8042: visit each map directly, without allocating and hashing a union.
    // Equal cardinality plus no changed base members proves equality; the
    // overwhelmingly common unchanged case needs only one lookup per member.
    // #8351: when every base member is also a head member, equal cardinality
    // proves the key sets are equal, so head-only members need no second pass.
    let mut shared = true;
    let mut keys: Vec<_> = base.iter().filter(|(key, value)| match head.get(*key) {
        Some(other) => other != *value,
        None => { shared = false; true },
    }).map(|(key, _)| key.clone()).collect();
    if shared && base.len() == head.len() {
        keys.sort_by(cmp_code_units);
        return keys;
    }
    keys.extend(head.keys().filter(|key| !base.contains_key(*key)).cloned());
    keys.sort_by(cmp_code_units);
    keys
}

/// The key pass is reusable by the subsequent content stages. Its output order
/// follows JS Map insertion order: first base appearances, then head-only keys.
pub fn diff_by_key<'a, R>(
    base: &'a [EntityFingerprint<R>], head: &'a [EntityFingerprint<R>], options: &KeyDiffOptions,
) -> KeyDiff<'a, R> {
    diff_by_key_impl(base, head, options, true)
}

pub(crate) fn diff_by_key_for_transport<'a, R>(
    base: &'a [EntityFingerprint<R>], head: &'a [EntityFingerprint<R>], options: &KeyDiffOptions,
) -> KeyDiff<'a, R> {
    diff_by_key_impl(base, head, options, false)
}

fn diff_by_key_impl<'a, R>(
    base: &'a [EntityFingerprint<R>], head: &'a [EntityFingerprint<R>], options: &KeyDiffOptions,
    build_index: bool,
) -> KeyDiff<'a, R> {
    let excluded: HashSet<JsString> = options.exclude_types.iter().map(normalize_type)
        .filter(|name| !name.is_empty()).collect();
    let is_excluded = |entity: &EntityFingerprint<R>| !excluded.is_empty() && excluded.contains(&normalize_type(&entity.ifc_type));
    let (base_order, base_index) = index(base);
    let (mut head_order, mut head_index) = index(head);
    let applied_key_aliases = options.key_aliases.as_ref()
        .map(|aliases| resolve_aliases(&base_order, &mut head_order, aliases));
    // The deduplication maps are already the first-occurrence indices. Only
    // alias replacement changes keys and requires rebuilding the head index.
    if applied_key_aliases.as_ref().is_some_and(|aliases| !aliases.is_empty()) {
        head_index = head_order.iter().map(|(key, i)| (key, *i)).collect();
    }
    let base_has_geometry = base_order.iter().any(|(key, i)| {
        base[*i].geometry_hash(options.strip_placement_geometry).is_some() && !is_excluded(&base[*i])
            && head_index.get(key).is_none_or(|j| !is_excluded(&head[*j]))
    });
    let head_has_geometry = head_order.iter().any(|(key, i)| {
        head[*i].geometry_hash(options.strip_placement_geometry).is_some() && !is_excluded(&head[*i])
            && base_index.get(key).is_none_or(|j| !is_excluded(&base[*j]))
    });
    let consider_data = options.scope != DiffScope::Geometry;
    let use_geometry = options.scope != DiffScope::Data && base_has_geometry == head_has_geometry;
    let mut entries = Vec::with_capacity(base_order.len().max(head_order.len()));
    // Ordered keys are unique on both sides, aliases included, so the base
    // pass already decides which head rows have a base key (#8351).
    let mut paired = vec![false; head.len()];
    for (key, i) in &base_order {
        let base_entity = &base[*i];
        let head_entity = head_index.get(key).map(|&j| { paired[j] = true; &head[j] });
        if is_excluded(base_entity) || head_entity.is_some_and(&is_excluded) { continue; }
        let mut entry = DiffEntry {
            key: key.clone(), state: DiffState::Deleted, change_kinds: Vec::new(),
            base: Some(base_entity), head: head_entity, changed_components: None,
        };
        if let Some(other) = head_entity {
            if consider_data && (base_entity.ifc_type != other.ifc_type || base_entity.data_hash != other.data_hash) {
                entry.change_kinds.push(DiffChangeKind::Data);
            }
            if use_geometry && base_entity.geometry_hash(options.strip_placement_geometry) != other.geometry_hash(options.strip_placement_geometry) {
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
        if paired[*i] || is_excluded(&head[*i]) { continue; }
        entries.push(DiffEntry {
            key: key.clone(), state: DiffState::Added, change_kinds: Vec::new(),
            base: None, head: Some(&head[*i]), changed_components: None,
        });
    }
    let mut counts = DiffCounts::default();
    let mut by_key = if build_index { HashMap::with_capacity(entries.len()) } else { HashMap::new() };
    for (i, entry) in entries.iter().enumerate() {
        if build_index { by_key.insert(entry.key.clone(), i); }
        match entry.state {
            DiffState::Added => counts.added += 1,
            DiffState::Modified => counts.modified += 1,
            DiffState::Deleted => counts.deleted += 1,
            DiffState::Unchanged => counts.unchanged += 1,
        }
    }
    let mut excluded_types: Vec<_> = excluded.into_iter().collect();
    excluded_types.sort_by(cmp_code_units);
    KeyDiff { scope: options.scope, excluded_types, entries, by_key, counts, applied_key_aliases, use_geometry, strip_placement_geometry: options.strip_placement_geometry }
}

#[cfg(test)]
#[path = "key_diff_tests.rs"]
mod tests;
