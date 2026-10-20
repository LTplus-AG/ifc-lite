// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve an original finite transversal source carrier during NEW refused-Q20
//! axis rescue's INITIAL foot. Existing secondary-axis completion is unchanged.
//! This is an admission restriction, not a Boolean closure proof.
use rustc_hash::FxHashMap;
use std::collections::HashSet;
use super::{selection::Face, NearBand, Tri};
use crate::kernel::{budget, near_band::vertex_bits, predicates::orient3d_explicit,
    tritri::{tri_tri_intersection_with_band, TriTri}, Sign};

type Key = [u64; 3];
pub(super) struct Proposal<'a> {
    pub(super) ti: usize,
    pub(super) vi: usize,
    pub(super) original: [f64; 3],
    pub(super) target: Option<[f64; 3]>,
    // Retained through in-place target resolution, before deferred writes.
    pub(super) admitted_q20_face: Option<(f64, &'a Face)>,
    // None preserves every original admitted-Q20 path, including its fallback.
    pub(super) refused_face: Option<&'a Face>,
    pub(super) initial_foot: Option<[f64; 3]>,
}
fn finite(p: [f64; 3]) -> bool { p.into_iter().all(f64::is_finite) }
fn side(p: [f64; 3], t: &Tri) -> Sign {
    orient3d_explicit(p, t[0], t[1], t[2])
}
fn certificate(source: &Tri, initial_foot: [f64; 3], face: &Face, band: &NearBand) -> bool {
    if budget::tripped() || !finite(initial_foot)
        || !source.iter().chain(face.t.iter()).all(|&p| finite(p)) { return false; }
    // A nonzero exact determinant also certifies source nondegeneracy. Its sign
    // is irrelevant: neither source winding nor an outward normal is inferred.
    if side(initial_foot, source) == Sign::Zero || budget::tripped() { return false; }
    let signs = source.map(|p| side(p, &face.t));
    if budget::tripped() || !signs.contains(&Sign::Positive)
        || !signs.contains(&Sign::Negative)
        || !source.iter().any(|&p| face.outside_normal_band(p)) { return false; }
    // Reuse the standing exact finite intersection and its unchanged near-band
    // behavior. Coplanar, Point, uncertain or budget-limited pairs do not certify.
    let segment = matches!(tri_tri_intersection_with_band(source, &face.t, band), TriTri::Segment(_));
    segment && !budget::tripped()
}

pub(super) fn rejected_keys(source: &[Tri], proposals: &[Proposal<'_>], band: &NearBand) -> HashSet<Key> {
    let mut groups: FxHashMap<Key, Option<(&Face, [f64; 3], [f64; 3])>> = FxHashMap::default();
    for p in proposals {
        let key = vertex_bits(&p.original);
        let candidate = p.refused_face.zip(p.initial_foot).zip(p.target)
            .map(|((face, foot), target)| (face, foot, target));
        groups.entry(key).and_modify(|old| {
            if !matches!((*old, candidate), (Some((a,f,x)), Some((b,g,y)))
                if std::ptr::eq(a,b) && vertex_bits(&f)==vertex_bits(&g)
                    && vertex_bits(&x)==vertex_bits(&y)) { *old=None; }
        }).or_insert(candidate);
    }
    if !groups.values().any(Option::is_some) || budget::tripped() { return HashSet::new(); }
    // Borrow source triangles; retain only original face indices, not a clone.
    let mut owners: FxHashMap<Key, Vec<usize>> = FxHashMap::default();
    for (i,t) in source.iter().enumerate() {
        for p in t {
            let indices = owners.entry(vertex_bits(p)).or_default();
            if indices.last()!=Some(&i) { indices.push(i); }
        }
    }
    let mut seen = HashSet::new();
    let mut rejected = HashSet::new();
    // Hash lookup only: predicates follow original proposal and source order.
    for p in proposals {
        let key=vertex_bits(&p.original);
        if !seen.insert(key) { continue; }
        let Some(Some((face,foot,_target)))=groups.get(&key) else { continue; };
        if owners.get(&key).is_some_and(|indices| indices.iter()
            .any(|&i| certificate(&source[i], *foot, face, band)
                && super::contact_stability::escapes_original_contact(
                    &source[i], p.original, *foot, face, band))) { rejected.insert(key); }
    }
    rejected
}

#[cfg(test)]
#[path = "transversal_tests.rs"]
mod tests;
