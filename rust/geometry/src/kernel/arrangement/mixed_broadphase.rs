// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative candidate enumeration for implicit constraint segments (#7292).
//! Only disjoint interval boxes are omitted. Uncertain coordinates retain every
//! candidate, and sorted source indices preserve the original crossing order.
use super::Validated;
use crate::kernel::{broadphase::{Aabb, Bvh}, interval::{IvLam, RnInterval, next_down, next_up}};

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
    pub(super) fn new(segments: &[Validated]) -> Self {
        Self::from_lambdas(segments.iter().map(|s| (&s.lambda.0,&s.lambda.1)))
    }
    fn from_lambdas<'a>(segments: impl Iterator<Item=(&'a IvLam,&'a IvLam)>) -> Self {
        let boxes: Vec<_>=segments.map(|(a,b)|segment_bounds(a,b)).collect();
        let mut known_indices=Vec::new();let mut unknown_indices=Vec::new();let mut known=Vec::new();
        for (i,bb) in boxes.iter().enumerate() {
            if let Some(bb)=bb {known_indices.push(i);known.push(*bb);}else{unknown_indices.push(i);}
        }
        Self {tree:Bvh::from_aabbs(&known),known_indices,unknown_indices,boxes}
    }
    pub(super) fn after(&self,k:usize)->Vec<usize> {
        let Some(bb)=self.boxes[k] else{return(k+1..self.boxes.len()).collect()};
        let mut hits=Vec::new();self.tree.query(&bb,&mut hits);
        let mut result:Vec<_>=hits.into_iter().map(|i|self.known_indices[i as usize])
            .chain(self.unknown_indices.iter().copied()).filter(|&i|i>k).collect();
        result.sort_unstable();result.dedup();result
    }
}

#[cfg(test)]
#[path = "mixed_broadphase_tests.rs"]
mod tests;
