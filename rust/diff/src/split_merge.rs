// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::JsString;
use std::collections::{HashMap, HashSet};
use crate::model::{DiffEntry, DiffState, EntityFingerprint};
use crate::split_types::*;
use crate::split_lanes::{in_place, displaced};
use crate::class_families::ClassFamilies;
use crate::geometry_compare::usable_aabb;
use crate::utf16::cmp_code_units;

pub fn detect_split_merge<'a, R>(entries: &[DiffEntry<'a, R>], use_geometry: bool,
    settings: SplitSettings, families: Option<&[Vec<JsString>]>) -> Option<Vec<SplitMergeClaim<'a, R>>> {
    if !use_geometry { return None; }
    let resolver = ClassFamilies::new(families);
    // Vec buckets preserve JavaScript Map insertion order.
    let mut added: Vec<(JsString, Vec<&EntityFingerprint<R>>)> = vec![];
    let mut deleted: Vec<(JsString, Vec<&EntityFingerprint<R>>)> = vec![];
    for entry in entries {
        let entity = match entry.state { DiffState::Added => entry.head, DiffState::Deleted => entry.base, _ => None };
        let Some(entity) = entity else { continue; };
        if !entity.aabb.as_ref().is_some_and(usable_aabb) { continue; }
        let side = if entry.state == DiffState::Added { &mut added } else { &mut deleted };
        let family = resolver.family_of(&entity.ifc_type);
        if let Some((_, bucket)) = side.iter_mut().find(|(key, _)| key == &family) { bucket.push(entity); }
        else { side.push((family, vec![entity])); }
    }
    let mut claims = vec![];
    for (wholes, other, kind) in [(&deleted, &added, SplitMergeKind::Split), (&added, &deleted, SplitMergeKind::Merge)] {
        for (family, wholes) in wholes {
            let Some((_, pieces)) = other.iter().find(|(key, _)| key == family) else { continue; };
            let in_place = in_place(wholes, pieces, kind, settings);
            let taken: HashSet<_> = in_place.iter().flat_map(|c| c.pieces.iter().map(|p| *p as *const _)).collect();
            let remaining: Vec<_> = pieces.iter().copied().filter(|p| !taken.contains(&(*p as *const _))).collect();
            claims.extend(in_place);
            claims.extend(displaced(wholes, &remaining, kind, settings));
        }
    }
    Some(resolve_claim_conflicts(claims))
}
fn rank<R>(claim: &SplitMergeClaim<'_, R>) -> [f64; 3] {
    [match claim.confidence { SplitConfidence::Verified => 0.0, SplitConfidence::Displaced => 1.0, SplitConfidence::Extent => 2.0 },
        -(claim.pieces.len() as f64), claim.volume_residual.map(f64::abs).unwrap_or(0.0)]
}
fn compare_rank(a: &[f64; 3], b: &[f64; 3]) -> std::cmp::Ordering {
    for i in 0..3 {
        if a[i] != b[i] { return if a[i] < b[i] { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }; }
    }
    std::cmp::Ordering::Equal
}
fn participants<R>(claim: &SplitMergeClaim<'_, R>) -> Vec<*const EntityFingerprint<R>> {
    std::iter::once(claim.whole).chain(claim.pieces.iter().copied()).map(|p| p as *const _).collect()
}
fn tiebreak<R>(claim: &SplitMergeClaim<'_, R>) -> JsString {
    let kind = match claim.kind { SplitMergeKind::Split => "split", SplitMergeKind::Merge => "merge" };
    let kind = JsString::from(kind);
    let parts: Vec<_> = std::iter::once(&kind).chain(std::iter::once(&claim.whole.key))
        .chain(claim.pieces.iter().map(|p| &p.key)).collect();
    JsString::concat(&parts, "\0")
}
pub fn resolve_claim_conflicts<R>(mut claims: Vec<SplitMergeClaim<'_, R>>) -> Vec<SplitMergeClaim<'_, R>> {
    claims.sort_by(|a, b| compare_rank(&rank(a), &rank(b)).then_with(|| cmp_code_units(&tiebreak(a), &tiebreak(b))));
    let mut claimed_by = HashMap::new();
    let mut accepted = HashSet::new();
    let mut contested_at = HashMap::new();
    for (index, candidate) in claims.iter().enumerate() {
        let rank = rank(candidate);
        let entities = participants(candidate);
        if entities.iter().any(|e| contested_at.get(e).is_some_and(|at| compare_rank(at, &rank).is_eq())) { continue; }
        let blockers: HashSet<usize> = entities.iter().filter_map(|e| claimed_by.get(e).copied()).filter(|i| accepted.contains(i)).collect();
        if blockers.is_empty() {
            accepted.insert(index);
            for entity in entities { claimed_by.insert(entity, index); }
            continue;
        }
        for blocker in blockers {
            let blocked_rank = self::rank(&claims[blocker]);
            if !compare_rank(&blocked_rank, &rank).is_eq() { continue; }
            accepted.remove(&blocker);
            for entity in participants(&claims[blocker]) {
                claimed_by.remove(&entity);
                contested_at.insert(entity, blocked_rank);
            }
            for &entity in &entities { contested_at.insert(entity, rank); }
        }
    }
    claims.into_iter().enumerate().filter_map(|(i, claim)| accepted.contains(&i).then_some(claim)).collect()
}
