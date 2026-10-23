// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::collections::{HashMap, HashSet};
use crate::content_types::ContentMatch;
use crate::identity_map::{identity_map_from_content_matches, identity_map_from_successors};
use crate::model::{DiffState, KeyDiff};
use crate::split_types::{SplitMergeClaim, SplitMergeKind, SplitConfidence};
use crate::successor::SuccessorClaim;
use crate::utf16::cmp_code_units;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageRelation { Identity, Split, Merge, Replaced }
#[derive(Debug, Clone, PartialEq)]
pub struct LineageEntry {
    pub base: Vec<String>, pub head: Vec<String>, pub relation: LineageRelation,
    pub reason: String, pub shares: Option<Vec<f64>>,
}
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lineage { pub entries: Vec<LineageEntry>, pub deleted: Vec<String> }
#[derive(Default)]
pub struct AliasProvenance {
    pub reasons: HashMap<String, String>,
    pub relations: HashMap<String, LineageRelation>,
}
pub fn lineage_of_diff<R>(diff: &KeyDiff<'_, R>, matches: &[ContentMatch<'_, R>], splits: &[SplitMergeClaim<'_, R>],
    accepted: &[SuccessorClaim<'_, R>], provenance: &AliasProvenance) -> Lineage {
    let mut entries = vec![];
    for (here, base) in diff.applied_key_aliases.iter().flatten() {
        let reason = provenance.reasons.get(here).cloned().unwrap_or_else(|| "alias:replayed".into());
        let relation = provenance.relations.get(here).copied().unwrap_or_else(||
            if reason.starts_with("successor:") { LineageRelation::Replaced } else { LineageRelation::Identity });
        entries.push(LineageEntry { base: vec![base.clone()], head: vec![here.clone()], relation, reason, shares: None });
    }
    for e in identity_map_from_content_matches(matches) {
        entries.push(LineageEntry { base: vec![e.base], head: vec![e.here], relation: LineageRelation::Identity, reason: e.reason, shares: None });
    }
    for claim in splits {
        let pieces: Vec<_> = claim.pieces.iter().map(|p| p.key.clone()).collect();
        let shares = if claim.confidence != SplitConfidence::Extent {
            claim.pieces_volume.filter(|v| *v > 0.0).and_then(|total| claim.pieces.iter()
                .map(|p| p.volume.filter(|v| v.is_finite() && *v > 0.0).map(|v| v / total)).collect())
        } else { None };
        let confidence = match claim.confidence { SplitConfidence::Verified => "verified", SplitConfidence::Extent => "extent", SplitConfidence::Displaced => "displaced" };
        let (base, head, relation, kind) = match claim.kind {
            SplitMergeKind::Split => (vec![claim.whole.key.clone()], pieces, LineageRelation::Split, "split"),
            SplitMergeKind::Merge => (pieces, vec![claim.whole.key.clone()], LineageRelation::Merge, "merge"),
        };
        entries.push(LineageEntry { base, head, relation, reason: format!("{kind}:{confidence}"), shares });
    }
    for e in identity_map_from_successors(accepted) {
        entries.push(LineageEntry { base: vec![e.base], head: vec![e.here], relation: LineageRelation::Replaced, reason: e.reason, shares: None });
    }
    entries.sort_by(|a, b| cmp_code_units(a.base.first().map(String::as_str).unwrap_or(""), b.base.first().map(String::as_str).unwrap_or(""))
        .then_with(|| cmp_code_units(a.head.first().map(String::as_str).unwrap_or(""), b.head.first().map(String::as_str).unwrap_or(""))));
    let accounted: HashSet<_> = entries.iter().flat_map(|e| e.base.iter()).collect();
    let mut deleted: Vec<_> = diff.entries.iter().filter(|e| e.state == DiffState::Deleted && !accounted.contains(&e.key)).map(|e| e.key.clone()).collect();
    deleted.sort_by(|a, b| cmp_code_units(a, b));
    Lineage { entries, deleted }
}
pub fn lineage_conflicts(entries: &[LineageEntry]) -> Vec<String> {
    let mut problems = vec![];
    for side in ["base", "head"] {
        let mut seen = HashSet::new();
        let mut repeated = HashSet::new();
        for entry in entries {
            for key in if side == "base" { &entry.base } else { &entry.head } {
                if !seen.insert(key) { repeated.insert(key); }
            }
        }
        let mut repeated: Vec<_> = repeated.into_iter().collect();
        repeated.sort_by(|a, b| cmp_code_units(a, b));
        for key in repeated { problems.push(format!("{side} key \"{key}\" appears in more than one lineage entry")); }
    }
    problems
}
/// Ordered pairs preserve the JavaScript Map iteration contract.
pub fn key_aliases_from_lineage(entries: &[LineageEntry]) -> Vec<(String, String)> {
    let mut claims: Vec<(String, String)> = vec![];
    let mut conflicted = HashSet::new();
    for entry in entries {
        if !matches!(entry.relation, LineageRelation::Identity | LineageRelation::Replaced) || entry.base.len() != 1 || entry.head.len() != 1 { continue; }
        let here = &entry.head[0]; let base = &entry.base[0];
        if let Some((_, claimed)) = claims.iter().find(|(h, _)| h == here) {
            if claimed != base { conflicted.insert(here.clone()); }
        } else { claims.push((here.clone(), base.clone())); }
    }
    claims.into_iter().filter(|(here, base)| here != base && !conflicted.contains(here)).collect()
}
#[derive(Debug, Clone, Copy)]
pub enum RekeyPolicy { CopyToAll, LargestShare, OrphanOnSplit }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RekeyRelation { Changed(LineageRelation), Unchanged }
#[derive(Debug, PartialEq)]
pub struct RekeyResult { pub key: String, pub successors: Vec<String>, pub relation: Option<RekeyRelation>, pub orphan: bool }
pub fn rekey_by_lineage(keys: &[String], lineage: &Lineage, policy: RekeyPolicy) -> Vec<RekeyResult> {
    let deleted: HashSet<_> = lineage.deleted.iter().collect();
    let mut by_base = HashMap::new();
    for entry in &lineage.entries { for key in &entry.base { by_base.entry(key).or_insert(entry); } }
    keys.iter().map(|key| {
        let Some(entry) = by_base.get(key) else {
            let orphan = deleted.contains(key);
            return RekeyResult { key: key.clone(), successors: if orphan { vec![] } else { vec![key.clone()] },
                relation: if orphan { None } else { Some(RekeyRelation::Unchanged) }, orphan };
        };
        let successors = if entry.relation != LineageRelation::Split || matches!(policy, RekeyPolicy::CopyToAll) { entry.head.clone() }
        else if matches!(policy, RekeyPolicy::LargestShare) {
            match &entry.shares {
                Some(shares) if shares.len() == entry.head.len() && !shares.is_empty() => {
                    let mut best = 0;
                    for i in 1..shares.len() { if shares[i] > shares[best] { best = i; } }
                    if shares.iter().filter(|&&s| s == shares[best]).count() > 1 { vec![] } else { vec![entry.head[best].clone()] }
                }, _ => vec![],
            }
        } else { vec![] };
        RekeyResult { key: key.clone(), orphan: entry.relation == LineageRelation::Split && successors.is_empty(),
            successors, relation: Some(RekeyRelation::Changed(entry.relation)) }
    }).collect()
}
