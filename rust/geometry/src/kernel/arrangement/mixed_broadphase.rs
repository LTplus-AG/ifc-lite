// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative candidate enumeration for implicit constraint segments (#7292).
//! Only disjoint interval boxes are omitted. Uncertain coordinates retain every
//! candidate, and sorted source indices preserve the original crossing order.
use super::Supported;
use crate::kernel::{ImplicitPoint, broadphase::{Aabb, Bvh}, interval::{IvLam, RnInterval, ilambda_cached, next_down, next_up}};

fn coordinate(n: RnInterval, d: RnInterval) -> Option<(f64, f64)> {
    if ![n.lo,n.hi,d.lo,d.hi].iter().all(|x| x.is_finite()) || n.lo>n.hi || d.lo>d.hi
        || !(d.lo > 0.0 || d.hi < 0.0) { return None; }
    let quotients = [n.lo/d.lo,n.lo/d.hi,n.hi/d.lo,n.hi/d.hi];
    if !quotients.iter().all(|x| x.is_finite()) { return None; }
    let lo = next_down(quotients.iter().copied().fold(f64::INFINITY, f64::min));
    let hi = next_up(quotients.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    (lo.is_finite() && hi.is_finite()).then_some((lo,hi))
}

fn segment_bounds(a: &IvLam, b: &IvLam) -> Option<Aabb> {
    let (mut lo,mut hi)=([0.;3],[0.;3]);
    for k in 0..3 {
        let aa=coordinate(a.0[k],a.1)?;
        let bb=coordinate(b.0[k],b.1)?;
        lo[k]=aa.0.min(bb.0);hi[k]=aa.1.max(bb.1);
    }
    Some((lo,hi))
}

pub(super) struct Candidates {
    tree: Bvh,
    known_indices: Vec<usize>,
    unknown_indices: Vec<usize>,
    boxes: Vec<Option<Aabb>>,
}
impl Candidates {
    pub(super) fn unvalidated(segments: &[Supported]) -> Self {
        Self::from_boxes(segments.iter().map(|s| {
            let c = &s.constraint;
            if !super::finite(&c.a) || !super::finite(&c.b) { return None; }
            segment_bounds(&ilambda_cached(&c.a), &ilambda_cached(&c.b))
        }).collect())
    }
    pub(super) fn points(points: &[ImplicitPoint]) -> Self {
        Self::from_boxes(points.iter().map(|p| {
            if !super::finite(p) { return None; }
            let lambda = ilambda_cached(p);
            segment_bounds(&lambda, &lambda)
        }).collect())
    }
    #[cfg(test)]
    fn from_lambdas<'a>(segments: impl Iterator<Item=(&'a IvLam,&'a IvLam)>) -> Self {
        Self::from_boxes(segments.map(|(a,b)|segment_bounds(a,b)).collect())
    }
    fn from_boxes(boxes: Vec<Option<Aabb>>) -> Self {
        let mut known_indices=Vec::new();let mut unknown_indices=Vec::new();let mut known=Vec::new();
        for (i,bb) in boxes.iter().enumerate() {
            if let Some(bb)=bb {known_indices.push(i);known.push(*bb);}else{unknown_indices.push(i);}
        }
        Self {tree:Bvh::from_aabbs(&known),known_indices,unknown_indices,boxes}
    }
    /// Union the actual constraints, never their carrier triangle. An unknown
    /// endpoint makes the union unknown too, retaining every point candidate.
    pub(super) fn bounds(&self) -> Option<Aabb> {
        let mut bounds = *self.boxes.first()?.as_ref()?;
        for bb in &self.boxes[1..] {
            let bb = bb.as_ref()?;
            for k in 0..3 {
                bounds.0[k] = bounds.0[k].min(bb.0[k]);
                bounds.1[k] = bounds.1[k].max(bb.1[k]);
            }
        }
        Some(bounds)
    }
    pub(super) fn at(&self, p: &IvLam) -> Vec<usize> {
        self.overlapping(segment_bounds(p, p))
    }
    pub(super) fn overlapping(&self, bb: Option<Aabb>) -> Vec<usize> {
        let Some(bb) = bb else { return (0..self.boxes.len()).collect(); };
        let mut hits=Vec::new();self.tree.query(&bb,&mut hits);
        let mut result:Vec<_>=hits.into_iter().map(|i|self.known_indices[i as usize])
            .chain(self.unknown_indices.iter().copied()).collect();
        result.sort_unstable();result.dedup();result
    }
    pub(super) fn after(&self,k:usize)->Vec<usize> {
        let mut result = self.overlapping(self.boxes[k]);
        result.retain(|&i| i > k); result
    }
}

#[cfg(test)]
#[path = "mixed_broadphase_tests.rs"]
mod tests;
