// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::JsString;
use std::collections::HashMap;
use crate::content_types::*;
use crate::geometry_compare::*;
use crate::model::{DiffEntry, EntityFingerprint};
use crate::mutual_nearest::mutual_nearest_pairs;
use crate::utf16::cmp_code_units;

pub(crate) fn fingerprint<'a, R>(entries: &[DiffEntry<'a, R>], index: usize) -> &'a EntityFingerprint<R> {
    entries[index].base.or(entries[index].head).expect("content candidate has an entity")
}

/// Buckets retain JS Map insertion order without depending on hash iteration.
#[derive(Default)]
pub(crate) struct Buckets {
    pub groups: Vec<(JsString, Vec<usize>)>,
    pub lookup: HashMap<JsString, usize>,
}
impl Buckets {
    pub fn push(&mut self, key: JsString, value: usize) {
        let index = match self.lookup.get(&key) {
            Some(index) => *index,
            None => {
                let index = self.groups.len();
                self.lookup.insert(key.clone(), index);
                self.groups.push((key, Vec::new()));
                index
            }
        };
        self.groups[index].1.push(value);
    }
    pub fn get(&self, key: &JsString) -> Option<&[usize]> {
        self.lookup.get(key).map(|index| self.groups[*index].1.as_slice())
    }
}

fn component_signature(components: &HashMap<JsString, JsString>) -> JsString {
    let mut keys: Vec<_> = components.keys().collect();
    keys.sort_by(cmp_code_units);
    let mut units = Vec::new();
    for key in keys {
        units.extend_from_slice(key.units()); units.push(0);
        units.extend_from_slice(components[key].units()); units.push(1);
    }
    JsString::from_units(units)
}
pub(crate) fn components_agree<R>(entries: &[DiffEntry<'_, R>], indices: impl IntoIterator<Item = usize>) -> bool {
    let mut signature = None;
    for index in indices {
        if let Some(components) = &fingerprint(entries, index).components {
            let current = component_signature(components);
            if let Some(previous) = &signature {
                if *previous != current { return false; }
            } else { signature = Some(current); }
        }
    }
    true
}

pub(crate) fn group_kind(base: usize, head: usize) -> ContentMatchKind {
    if base == 1 && head == 1 { ContentMatchKind::Ambiguous }
    else if base == 1 { ContentMatchKind::Duplicated }
    else if head == 1 { ContentMatchKind::Deduplicated }
    else { ContentMatchKind::Ambiguous }
}
pub(crate) fn classify_pair<R>(
    base: &EntityFingerprint<R>, head: &EntityFingerprint<R>, use_geometry: bool, tolerances: GeometryTolerances,
) -> (ContentMatchKind, Option<f64>) {
    if !use_geometry || base.geometry_hash == head.geometry_hash { return (ContentMatchKind::Renamed, None); }
    let change = classify_geometry_change(base.aabb.as_ref(), head.aabb.as_ref(), tolerances);
    (match change.kind { GeometryChangeKind::Moved => ContentMatchKind::Moved, GeometryChangeKind::Reshaped => ContentMatchKind::Reshaped }, change.distance)
}

pub(crate) fn pair_by_position<R>(
    entries: &[DiffEntry<'_, R>], base: &[usize], head: &[usize], use_geometry: bool, tolerances: GeometryTolerances,
) -> Vec<(usize, usize)> {
    if !use_geometry || base.len() > 128 || head.len() > 128 { return Vec::new(); }
    let centres = |indices: &[usize]| -> Option<Vec<[f64; 3]>> {
        indices.iter().map(|i| fingerprint(entries, *i).aabb.as_ref()
            .filter(|aabb| usable_aabb(aabb)).map(centre)).collect()
    };
    let (Some(a), Some(b)) = (centres(base), centres(head)) else { return Vec::new() };
    mutual_nearest_pairs(&a, &b, tolerances.max_move_distance,
        |i, j| components_agree(entries, [base[i], head[j]]), 1.0)
        .iter().map(|pair| (base[pair.base], head[pair.head])).collect()
}

pub(crate) fn make_match<'a, R>(
    entries: &[DiffEntry<'a, R>], base: &[usize], head: &[usize], kind: ContentMatchKind,
    tier: ContentMatchTier, data_hash: &JsString, distance: Option<f64>,
) -> ContentMatch<'a, R> {
    ContentMatch {
        kind, tier, data_hash: data_hash.into(), geometry_hash: None, changed_components: None,
        base: base.iter().map(|i| fingerprint(entries, *i)).collect(),
        head: head.iter().map(|i| fingerprint(entries, *i)).collect(), distance,
    }
}
