// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Additive replacement-in-place claims, after content and split/merge (#8042).
use std::collections::{HashMap, HashSet};
use crate::class_families::{ClassFamilies, normalize_class};
use crate::geometry_compare::{GeometryTolerances, centre, centre_distance, positive_or, usable_aabb};
use crate::model::{DiffEntry, DiffState, EntityAabb, EntityFingerprint};
use crate::mutual_nearest::mutual_nearest_pairs;
use crate::split_geometry::box_iou;
use crate::utf16::cmp_code_units;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuccessorConfidence { Footprint, Position }
#[derive(Debug)]
pub struct SuccessorClaim<'a, R> {
    pub confidence: SuccessorConfidence,
    pub base: &'a EntityFingerprint<R>,
    pub head: &'a EntityFingerprint<R>,
    pub overlap: f64,
    pub distance: f64,
    pub agreeing_components: Option<Vec<String>>,
    pub cross_class: bool,
}
#[derive(Debug, Clone, Copy)]
pub struct SuccessorSettings { pub overlap: f64, pub distance: f64 }
impl Default for SuccessorSettings {
    fn default() -> Self { Self::resolve(None, None) }
}
impl SuccessorSettings {
    pub fn resolve(overlap: Option<f64>, distance: Option<f64>) -> Self {
        let overlap = positive_or(overlap, 0.6);
        Self { overlap: if overlap > 0.0 && overlap <= 1.0 { overlap } else { 0.6 }, distance: positive_or(distance, 0.5) }
    }
}
fn bbox<R>(e: &EntityFingerprint<R>) -> &EntityAabb { e.aabb.as_ref().expect("successor candidate has a box") }
fn sizes_comparable(a: &EntityAabb, b: &EntityAabb) -> bool {
    for axis in 0..3 {
        let ea = a.max[axis] - a.min[axis];
        let eb = b.max[axis] - b.min[axis];
        let big = ea.max(eb);
        let small = ea.min(eb);
        if big <= 0.0 { continue; }
        if small <= 0.0 || big / small > 2.0 { return false; }
    }
    true
}
fn diagonal(b: &EntityAabb) -> f64 {
    let dx = b.max[0] - b.min[0];
    let dy = b.max[1] - b.min[1];
    let dz = b.max[2] - b.min[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}
fn claim<'a, R>(confidence: SuccessorConfidence, base: &'a EntityFingerprint<R>, head: &'a EntityFingerprint<R>,
    overlap: f64, tolerances: GeometryTolerances) -> SuccessorClaim<'a, R> {
    let raw = centre_distance(centre(bbox(base)), centre(bbox(head)));
    let agreeing_components = base.components.as_ref().zip(head.components.as_ref()).map(|(a, b)| {
        let mut keys: Vec<_> = a.iter().filter(|(key, value)| b.get(*key) == Some(*value)).map(|(key, _)| key.clone()).collect();
        keys.sort_by(|a, b| cmp_code_units(a, b));
        keys
    });
    SuccessorClaim { confidence, base, head, overlap,
        distance: if raw > tolerances.move_tolerance { raw } else { 0.0 }, agreeing_components,
        cross_class: normalize_class(&base.ifc_type) != normalize_class(&head.ifc_type) }
}
fn footprint<'a, R>(bases: &[&'a EntityFingerprint<R>], heads: &[&'a EntityFingerprint<R>],
    settings: SuccessorSettings, tolerances: GeometryTolerances) -> (Vec<SuccessorClaim<'a, R>>, HashSet<usize>, HashSet<usize>) {
    let mut best_head = vec![None; bases.len()];
    let mut head_iou = vec![0.0; bases.len()];
    let mut second_head = vec![0.0; bases.len()];
    let mut best_base = vec![None; heads.len()];
    let mut base_iou = vec![0.0; heads.len()];
    let mut second_base = vec![0.0; heads.len()];
    for (b, base) in bases.iter().enumerate() {
        for (h, head) in heads.iter().enumerate() {
            let iou = box_iou(bbox(base), bbox(head));
            if iou > head_iou[b] {
                second_head[b] = head_iou[b]; head_iou[b] = iou; best_head[b] = Some(h);
            } else if iou > second_head[b] { second_head[b] = iou; }
            if iou > base_iou[h] {
                second_base[h] = base_iou[h]; base_iou[h] = iou; best_base[h] = Some(b);
            } else if iou > second_base[h] { second_base[h] = iou; }
        }
    }
    let mut claims = vec![];
    let mut paired_base = HashSet::new();
    let mut paired_head = HashSet::new();
    for b in 0..bases.len() {
        let Some(h) = best_head[b] else { continue; };
        if best_base[h] != Some(b) || head_iou[b] < settings.overlap { continue; }
        if second_head[b] >= settings.overlap / 2.0 || second_base[h] >= settings.overlap / 2.0 { continue; }
        paired_base.insert(b); paired_head.insert(h);
        claims.push(claim(SuccessorConfidence::Footprint, bases[b], heads[h], head_iou[b], tolerances));
    }
    (claims, paired_base, paired_head)
}
fn position<'a, R>(bases: &[&'a EntityFingerprint<R>], heads: &[&'a EntityFingerprint<R>],
    settings: SuccessorSettings, tolerances: GeometryTolerances) -> Vec<SuccessorClaim<'a, R>> {
    let bc: Vec<_> = bases.iter().map(|e| centre(bbox(e))).collect();
    let hc: Vec<_> = heads.iter().map(|e| centre(bbox(e))).collect();
    let accept = |b: usize, h: usize| sizes_comparable(bbox(bases[b]), bbox(heads[h])) &&
        centre_distance(bc[b], hc[h]) <= settings.distance.max(0.5 * diagonal(bbox(bases[b])));
    mutual_nearest_pairs(&bc, &hc, f64::INFINITY, accept, 2.0).into_iter().map(|p|
        claim(SuccessorConfidence::Position, bases[p.base], heads[p.head], box_iou(bbox(bases[p.base]), bbox(heads[p.head])), tolerances)).collect()
}
type Bucket<'a, R> = Vec<&'a EntityFingerprint<R>>;
/// `bound` contains the participants of accepted split/merge claims; identity is
/// reference identity, never equality of GlobalIds or fingerprint values.
pub fn detect_successors<'a, R>(entries: &[DiffEntry<'a, R>], use_geometry: bool, bound: &[&EntityFingerprint<R>],
    settings: SuccessorSettings, tolerances: GeometryTolerances, families: Option<&[Vec<String>]>) -> Option<Vec<SuccessorClaim<'a, R>>> {
    if !use_geometry { return None; }
    let bound: HashSet<_> = bound.iter().map(|p| *p as *const _).collect();
    let resolver = ClassFamilies::new(families);
    let mut added: HashMap<String, Bucket<'a, R>> = HashMap::new();
    let mut deleted: HashMap<String, Bucket<'a, R>> = HashMap::new();
    for entry in entries {
        let e = match entry.state { DiffState::Added => entry.head, DiffState::Deleted => entry.base, _ => None };
        let Some(e) = e else { continue; };
        if bound.contains(&(e as *const _)) || !e.aabb.as_ref().is_some_and(usable_aabb) { continue; }
        let side = if entry.state == DiffState::Added { &mut added } else { &mut deleted };
        side.entry(resolver.family_of(&e.ifc_type)).or_default().push(e);
    }
    let mut claims = vec![];
    for (family, bases) in deleted {
        let Some(heads) = added.get(&family) else { continue; };
        if bases.len() > 1024 || heads.len() > 1024 { continue; }
        let (first, paired_base, paired_head) = footprint(&bases, heads, settings, tolerances);
        claims.extend(first);
        let mut containers: HashMap<&str, (Bucket<'a, R>, Bucket<'a, R>)> = HashMap::new();
        for (i, &e) in bases.iter().enumerate() {
            if paired_base.contains(&i) { continue; }
            if let Some(c) = e.container.as_deref().filter(|c| !c.is_empty()) { containers.entry(c).or_default().0.push(e); }
        }
        for (i, &e) in heads.iter().enumerate() {
            if paired_head.contains(&i) { continue; }
            if let Some(c) = e.container.as_deref().filter(|c| !c.is_empty()) { containers.entry(c).or_default().1.push(e); }
        }
        for (bases, heads) in containers.into_values() {
            if !bases.is_empty() && !heads.is_empty() { claims.extend(position(&bases, &heads, settings, tolerances)); }
        }
    }
    claims.sort_by(|a, b| cmp_code_units(&a.base.key, &b.base.key).then_with(|| cmp_code_units(&a.head.key, &b.head.key)));
    Some(claims)
}
