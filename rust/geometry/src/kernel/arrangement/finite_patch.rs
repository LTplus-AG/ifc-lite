// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{Tri, dot3, drop_axis_of, coincident_planes, e, orient2d_any, Sign};
use super::surface::{near_shared_surface_tri, near_plane_normal, whole_cell_band};
use crate::kernel::{budget, ImplicitPoint, near_band::NearBand};
use rustc_hash::FxHashMap;
use std::cell::OnceCell;

type PointKey = [u64; 3];
fn key(p: [f64; 3]) -> PointKey { p.map(|v| if v == 0.0 { 0 } else { v.to_bits() }) }
fn edge(a: [f64; 3], b: [f64; 3]) -> (PointKey, PointKey) {
    let (a,b) = (key(a),key(b));
    if a < b { (a,b) } else { (b,a) }
}
#[derive(Clone, Copy)]
enum Uses { One(usize), Two(usize,usize), Ambiguous }

/// Original finite source-edge incidence, built once only after a single-face
/// containment fails. An edge with any third use cannot supply a patch pair.
pub(super) struct AdjacentFaces { neighbors: Vec<[Option<usize>; 3]> }
impl AdjacentFaces {
    fn new(tris: &[Tri]) -> Self {
        // Lookup only: both registration and neighbor emission follow tris.
        let mut uses = FxHashMap::default();
        for (i,t) in tris.iter().enumerate() {
            for k in 0..3 {
                uses.entry(edge(t[k],t[(k+1)%3])).and_modify(|v| {
                    *v = match *v { Uses::One(j) => Uses::Two(j,i), _ => Uses::Ambiguous };
                }).or_insert(Uses::One(i));
            }
        }
        let neighbors = tris.iter().enumerate().map(|(i,t)| std::array::from_fn(|k| {
            match uses[&edge(t[k],t[(k+1)%3])] {
                Uses::Two(a,b) if a != b => Some(if a == i { b } else { a }),
                _ => None,
            }
        })).collect();
        Self { neighbors }
    }
}

/// Both source triangles share the ACTUAL 3D edge. Four same-sign exact turns
/// prove their projected union is precisely this convex quad, including its
/// internal diagonal. Hence whole-cell containment follows from three symbolic
/// vertex tests against its four boundary halfplanes, without filling a gap.
fn pair_contains(own: [&ImplicitPoint; 3], t: &Tri, u: &Tri, k: usize, axis: crate::kernel::DropAxis) -> bool {
    let (a,b,c) = (t[k],t[(k+1)%3],t[(k+2)%3]);
    if a == b || !u.contains(&a) || !u.contains(&b) { return false; }
    let Some(&d) = u.iter().find(|&&p| p != a && p != b) else { return false };
    let q = [c,a,d,b];
    let w = orient2d_any(&e(q[0]),&e(q[1]),&e(q[2]),axis);
    if w == Sign::Zero { return false; }
    for i in 1..4 {
        if budget::tripped() || orient2d_any(&e(q[i]),&e(q[(i+1)%4]),&e(q[(i+2)%4]),axis) != w { return false; }
    }
    own.into_iter().all(|p| (0..4).all(|i| !budget::tripped()
        && orient2d_any(&e(q[i]),&e(q[(i+1)%4]),p,axis) != w.flip()))
}

/// Preserve the single-face fast path and its centroid locator. Only its finite
/// footprint may extend, to one original edge-adjacent source face. EACH plane
/// independently keeps the existing whole-cell band and angle/polarity tests.
/// No source or arranged coordinate changes, interpolation, or new point type.
pub(super) fn near_shared_patch(
    c: [f64; 3], n_own: [f64; 3], own: &Tri, exact: [&ImplicitPoint; 3],
    others: &[Tri], index: usize, band: &NearBand, adjacency: &OnceCell<AdjacentFaces>,
) -> Option<[f64; 3]> {
    let t = &others[index];
    if let Some(n) = near_shared_surface_tri(c,own,exact,t,band) {
        return coincident_planes(n_own,n).then_some(n);
    }
    // The same existing centroid-in-triangle locator is mandatory before any
    // pair lookup. Its plane test is shared with the single-face primitive.
    let n = near_plane_normal(c,t,band)?;
    if !coincident_planes(n_own,n) || !whole_cell_band(own,t,n,band)
        || !super::surface::symbolic_point_in_tri_proj(&e(c),t,n) || budget::tripped() { return None; }
    if dot3(n_own,n) == 0.0 { return None; }
    let axis = drop_axis_of(n);
    let adjacent = adjacency.get_or_init(|| AdjacentFaces::new(others));
    for k in 0..3 {
        if budget::tripped() { return None; }
        let Some(j) = adjacent.neighbors[index][k] else { continue };
        let u = &others[j];
        let Some(m) = near_plane_normal(c,u,band) else { continue };
        if dot3(n_own,m) == 0.0 || drop_axis_of(m) != axis || !coincident_planes(n_own,m)
            || (dot3(n_own,n) > 0.0) != (dot3(n_own,m) > 0.0)
            || !whole_cell_band(own,u,m,band) { continue; }
        if pair_contains(exact,t,u,k,axis) { return Some(n); }
    }
    None
}

#[cfg(test)]
#[path = "finite_patch_tests.rs"]
mod tests;
