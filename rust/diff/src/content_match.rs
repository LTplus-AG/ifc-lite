// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ordered content tiers: geometry+data, geometry-only, then residue/position.
use crate::content_helpers::*;
use crate::content_types::*;
use crate::geometry_compare::*;
use crate::key_diff::changed_components;
use crate::model::{DiffEntry, DiffState, KeyDiff};

fn split<R>(entries: &[DiffEntry<'_, R>], indices: &[usize]) -> (Vec<usize>, Vec<usize>) {
    indices.iter().copied().partition(|i| entries[*i].state == DiffState::Deleted)
}
fn live(indices: &[usize], retired: &[bool]) -> Vec<usize> {
    indices.iter().copied().filter(|i| !retired[*i]).collect()
}
fn retire(indices: impl IntoIterator<Item = usize>, retired: &mut [bool]) {
    for i in indices { retired[i] = true; }
}

pub fn apply_content_matching<'a, R>(mut core: KeyDiff<'a, R>, tolerances: GeometryTolerances) -> ContentDiff<'a, R> {
    let entries = &core.entries;
    let mut bases = Buckets::default();
    let mut heads = Buckets::default();
    for (i, entry) in entries.iter().enumerate() {
        let bucket = match entry.state {
            DiffState::Added => &mut heads, DiffState::Deleted => &mut bases, _ => continue,
        };
        let entity = fingerprint(entries, i);
        bucket.push(format!("{}\0{}", entity.ifc_type, entity.data_hash), i);
    }
    let mut retired = vec![false; entries.len()];
    let mut matches = Vec::new();
    let mut geometry_groups = Vec::new();
    if core.use_geometry {
        // Phase 1: equal-cardinality geometry subgroups inside each data bucket.
        for (key, head_group) in &heads.groups {
            let Some(base_group) = bases.get(key) else { continue };
            let mut geometry = Buckets::default();
            for i in base_group.iter().chain(head_group) {
                if let Some(hash) = &fingerprint(entries, *i).geometry_hash { geometry.push(hash.clone(), *i); }
            }
            for (_, group) in geometry.groups {
                let (base, head) = split(entries, &group);
                if base.is_empty() || base.len() != head.len() || !components_agree(entries, group.iter().copied()) { continue; }
                matches.push(make_match(entries, &base, &head, ContentMatchKind::Renamed,
                    ContentMatchTier::GeometryHash, &fingerprint(entries, head[0]).data_hash, None));
                retire(group, &mut retired);
            }
        }
        // Phase 2: regroup the union residue by class and geometry. Traversal
        // follows data-bucket insertion order, exactly as in TypeScript.
        let mut geometry = Buckets::default();
        for (_, group) in bases.groups.iter().chain(&heads.groups) {
            for i in live(group, &retired) {
                let entity = fingerprint(entries, i);
                let (Some(hash), Some(aabb)) = (&entity.geometry_hash, &entity.aabb) else { continue };
                if usable_aabb(aabb) { geometry.push(format!("{}\0{}", entity.ifc_type, hash), i); }
            }
        }
        for (_, group) in geometry.groups {
            let (base, head) = split(entries, &group);
            if base.is_empty() || head.is_empty() { continue; }
            let geometry_hash = fingerprint(entries, head[0]).geometry_hash.clone();
            if base.len() == 1 && head.len() == 1 {
                let a = fingerprint(entries, base[0]);
                let b = fingerprint(entries, head[0]);
                let (Some(ab), Some(bb)) = (&a.aabb, &b.aabb) else { continue };
                if !size_agrees(ab, bb, tolerances.reshape_tolerance)
                    || centre_distance(centre(ab), centre(bb)).partial_cmp(&tolerances.move_tolerance)
                        .is_none_or(|order| order.is_gt())
                    || a.data_hash == b.data_hash { continue; }
                let mut matched = make_match(entries, &base, &head, ContentMatchKind::Respecified,
                    ContentMatchTier::GeometryOnly, &b.data_hash, None);
                matched.geometry_hash = geometry_hash;
                if let (Some(ac), Some(bc)) = (&a.components, &b.components) {
                    matched.changed_components = Some(changed_components(ac, bc));
                }
                matches.push(matched);
                retire(group, &mut retired);
            } else if base.len() == head.len() {
                geometry_groups.push((base, head, geometry_hash));
            }
        }
    }
    // Phase 3: unique residue pairs, then mutual-nearest positions, then groups.
    for (key, head_group) in &heads.groups {
        let Some(base_group) = bases.get(key) else { continue };
        let base = live(base_group, &retired);
        let head = live(head_group, &retired);
        if base.is_empty() || head.is_empty() { continue; }
        let data_hash = &fingerprint(entries, head_group[0]).data_hash;
        if base.len() == 1 && head.len() == 1 {
            if components_agree(entries, [base[0], head[0]]) {
                let (kind, distance) = classify_pair(fingerprint(entries, base[0]), fingerprint(entries, head[0]), core.use_geometry, tolerances);
                matches.push(make_match(entries, &base, &head, kind, ContentMatchTier::ResidueOneToOne, data_hash, distance));
                retire([base[0], head[0]], &mut retired);
            }
            continue;
        }
        for (b, h) in pair_by_position(entries, &base, &head, core.use_geometry, tolerances) {
            let (kind, distance) = classify_pair(fingerprint(entries, b), fingerprint(entries, h), core.use_geometry, tolerances);
            matches.push(make_match(entries, &[b], &[h], kind, ContentMatchTier::Positional, data_hash, distance));
            retire([b, h], &mut retired);
        }
        let base = live(&base, &retired);
        let head = live(&head, &retired);
        if !base.is_empty() && !head.is_empty() {
            matches.push(make_match(entries, &base, &head, group_kind(base.len(), head.len()), ContentMatchTier::Unresolved, data_hash, None));
        }
    }
    for (base, head, geometry_hash) in geometry_groups {
        let base = live(&base, &retired);
        let head = live(&head, &retired);
        if base.is_empty() || head.is_empty() { continue; }
        let mut group = make_match(entries, &base, &head, group_kind(base.len(), head.len()), ContentMatchTier::Unresolved, "", None);
        group.geometry_hash = geometry_hash;
        matches.push(group);
    }
    for (i, entry) in entries.iter().enumerate() {
        if retired[i] {
            match entry.state {
                DiffState::Added => core.counts.added -= 1,
                DiffState::Deleted => core.counts.deleted -= 1,
                _ => unreachable!("only added/deleted entries can be candidates"),
            }
        }
    }
    let mut index = 0;
    core.entries.retain(|_| { let keep = !retired[index]; index += 1; keep });
    core.by_key = core.entries.iter().enumerate().map(|(i, entry)| (entry.key.clone(), i)).collect();
    ContentDiff { core, content_matches: matches }
}
