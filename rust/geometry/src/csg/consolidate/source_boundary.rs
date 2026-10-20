// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Additional failed-conform retry: triangulate the ORIGINAL source boundary.
//! No overlay, snapping, simplification, raw fallback or new boundary points.
use super::{buckets::Buckets, conform::{PlanBucket, CONFORM_TOL}, supported_cells};
use super::source_boundary_graph::{partition, rings, Partition};
use crate::{math::geom2d::{orientation, segments_intersect}, mesh::Mesh};
use nalgebra::{Point2, Point3};
use num_rational::BigRational;
use num_traits::{Signed, Zero};
use std::collections::BTreeMap;

type XY = [f64; 2];

/// Reuse the source partition only after its complete projected nonoverlap
/// certificate succeeds (the existing 4096-pair bound). All buckets/components
/// must succeed; the caller still applies cleanup and all closure/needle bars.
pub(super) fn build(plans: &[PlanBucket], buckets: &Buckets) -> Option<Mesh> {
    let mut output = Mesh::new();
    for (bid, tris) in buckets.values().enumerate() {
        if !supported_cells::nonoverlapping(tris) { return None; }
        let plan = plans.iter().find(|p| p.bid as usize == bid)?;
        let source = partition(tris)?;
        // Use the SAME dominant-coordinate projection as the nonoverlap proof,
        // avoiding another rotated projection's rounding of source boundaries.
        let n = tris.first()?.normal.map(f64::abs);
        let axes = if n.x >= n.y && n.x >= n.z { (1,2) }
            else if n.y >= n.z { (2,0) } else { (0,1) };
        certify_height_span(&source, 3-axes.0-axes.1)?;
        let xy: Vec<_> = source.points.iter().map(|p| [p[axes.0],p[axes.1]]).collect();
        let mut projected = BTreeMap::new();
        for (id, p) in source.points.iter().enumerate() {
            let key = xy[id].map(|x| if x == 0.0 { 0 } else { x.to_bits() });
            if projected.insert(key, id).is_some() { return None; }
            // Plane buckets may aggregate slightly noncoplanar faces. Exact
            // projected identity never authorizes an arbitrary normal movement.
            let delta = p - plan.origin;
            let lifted = plan.origin + plan.u_axis * delta.dot(&plan.u_axis)
                + plan.v_axis * delta.dot(&plan.v_axis);
            let stored = Point3::from(lifted.coords.map(|v| f64::from(v as f32)));
            if stored.iter().any(|v| !v.is_finite())
                || (stored - p).norm_squared() > CONFORM_TOL * CONFORM_TOL { return None; }
        }
        let first = source.faces.first()?;
        let winding = orientation(xy[first[0]],xy[first[1]],xy[first[2]]);
        if winding == 0 || source.faces.iter().any(|t|
            orientation(xy[t[0]],xy[t[1]],xy[t[2]]) != winding) { return None; }
        for component in &source.components {
            let loops = rings(&source.faces, component)?;
            emit_component(&mut output, &source, &xy, loops, winding, plan)?;
        }
    }
    (!output.is_empty()).then_some(output)
}

/// Both positive projected partitions fill the same domain. Their heights
/// along the dropped axis lie in the SAME residual interval of the first
/// source plane, so this exact SPAN bound proves bidirectional surface distance
/// <= CONFORM_TOL. Independent +/-tol point-to-plane bounds would permit 2tol.
fn certify_height_span(source: &Partition, drop: usize) -> Option<()> {
    let points: Vec<[BigRational;3]> = source.points.iter().map(|p| Some([
        BigRational::from_float(p.x)?, BigRational::from_float(p.y)?,
        BigRational::from_float(p.z)?,
    ])).collect::<Option<_>>()?;
    let [a,b,c] = source.faces.first()?.map(|i| &points[i]);
    let u: [BigRational;3] = std::array::from_fn(|i| &b[i]-&a[i]);
    let v: [BigRational;3] = std::array::from_fn(|i| &c[i]-&a[i]);
    let n = [&u[1]*&v[2]-&u[2]*&v[1], &u[2]*&v[0]-&u[0]*&v[2],
        &u[0]*&v[1]-&u[1]*&v[0]];
    let bound = n[drop].abs()*BigRational::from_float(CONFORM_TOL)?;
    if bound.is_zero() { return None; }
    let residual = |p: &[BigRational;3]| p.iter().zip(&n).map(|(p,n)| p*n).sum::<BigRational>();
    let mut lo = residual(points.first()?);
    let mut hi = lo.clone();
    for p in &points[1..] {
        let h = residual(p);
        if h < lo { lo = h.clone(); }
        if h > hi { hi = h; }
    }
    (hi-lo <= bound).then_some(())
}

// Exact winding-number containment. Boundary contacts were already rejected
// by the closed segment-intersection certificate below.
fn inside(p: XY, ring: &[usize], xy: &[XY]) -> bool {
    let mut winding = 0;
    for i in 0..ring.len() {
        let (a,b) = (xy[ring[i]],xy[ring[(i+1)%ring.len()]]);
        let side = orientation(a,b,p);
        if a[1] <= p[1] && b[1] > p[1] && side > 0 { winding += 1; }
        if a[1] > p[1] && b[1] <= p[1] && side < 0 { winding -= 1; }
    }
    winding != 0
}

fn ring_winding(ring: &[usize], xy: &[XY]) -> i32 {
    let mut least = 0;
    for i in 1..ring.len() {
        let (a,b) = (xy[ring[i]],xy[ring[least]]);
        if a[0] < b[0] || a[0] == b[0] && a[1] < b[1] { least = i; }
    }
    orientation(xy[ring[(least+ring.len()-1)%ring.len()]],xy[ring[least]],
        xy[ring[(least+1)%ring.len()]])
}

/// Reject self-crossings, nonadjacent contacts, and contacts between hole rings.
/// Adjacent collinear edges may continue forward, but may never double back.
fn simple(loops: &[Vec<usize>], xy: &[XY]) -> bool {
    let edges: Vec<_> = loops.iter().enumerate().flat_map(|(r,ring)|
        (0..ring.len()).map(move |i| (r,i,ring[i],ring[(i+1)%ring.len()]))).collect();
    if edges.len().saturating_mul(edges.len().saturating_sub(1))/2 > 4096 { return false; }
    for (i,&(r,k,a,b)) in edges.iter().enumerate() {
        for &(s,l,c,d) in &edges[i+1..] {
            let adjacent = r == s && ((k+1)%loops[r].len() == l || (l+1)%loops[r].len() == k);
            if adjacent {
                let (before,corner,after) = if b == c { (a,b,d) } else { (c,d,b) };
                if crate::math::geom2d::on_segment(xy[before],xy[corner],xy[after])
                    || crate::math::geom2d::on_segment(xy[corner],xy[after],xy[before]) { return false; }
            } else if segments_intersect(xy[a],xy[b],xy[c],xy[d]) { return false; }
        }
    }
    true
}

fn emit_component(
    output: &mut Mesh, source: &Partition, xy: &[XY], mut loops: Vec<Vec<usize>>,
    winding: i32, plan: &PlanBucket,
) -> Option<()> {
    if !simple(&loops, xy) { return None; }
    let mut outer = None;
    for (i, ring) in loops.iter().enumerate() {
        let sign = ring_winding(ring, xy);
        if sign == winding {
            if outer.replace(i).is_some() { return None; }
        } else if sign != -winding { return None; }
    }
    loops.swap(0,outer?);
    for i in 1..loops.len() {
        if !inside(xy[loops[i][0]], &loops[0], xy)
            || (1..loops.len()).any(|j| i != j && inside(xy[loops[i][0]], &loops[j], xy)) {
            return None;
        }
    }
    let ring_points = |ring: &[usize]| ring.iter().map(|&id| Point2::from(xy[id])).collect::<Vec<_>>();
    let outer = ring_points(&loops[0]);
    let holes: Vec<_> = loops[1..].iter().map(|r| ring_points(r)).collect();
    // Direct CDT: no wrapper sanitization/earcut fallback and no Steiner points.
    let (points, mut indices) = crate::cdt::triangulate_constrained(&outer,&holes)?;
    let ids: Vec<_> = loops.iter().flatten().copied().collect();
    if points.len() != ids.len() || points.iter().zip(&ids).any(|(p,&id)| [p.x,p.y] != xy[id])
        || !indices.len().is_multiple_of(3) || indices.iter().any(|&id| id >= ids.len()) { return None; }
    for tri in indices.chunks_exact_mut(3) {
        if orientation([points[tri[0]].x,points[tri[0]].y],
            [points[tri[1]].x,points[tri[1]].y], [points[tri[2]].x,points[tri[2]].y]) != 1 { return None; }
        if winding < 0 { tri.swap(1,2); }
    }
    if !constraints_preserved(&loops,&ids,&indices) { return None; }
    let base = output.vertex_count() as u32;
    for &id in &ids { output.add_vertex(source.points[id],plan.normal); }
    for tri in indices.chunks_exact(3) {
        output.add_triangle(base+tri[0] as u32,base+tri[1] as u32,base+tri[2] as u32);
    }
    Some(())
}

/// Require every ORIGINAL directed boundary segment exactly once, with no
/// reverse use. Every other output edge must pair once in each direction.
/// A CDT that drops a collinear corner, splits a constraint or drops an entire
/// ring/component is rejected even if its input vertex array still contains it.
fn constraints_preserved(loops: &[Vec<usize>], ids: &[usize], indices: &[usize]) -> bool {
    let mut counts = BTreeMap::<(usize,usize),(usize,usize)>::new();
    for t in indices.chunks_exact(3) {
        for i in 0..3 {
            let (a,b) = (ids[t[i]],ids[t[(i+1)%3]]);
            if a == b { return false; }
            let c = counts.entry((a.min(b),a.max(b))).or_default();
            if a < b { c.0 += 1; } else { c.1 += 1; }
        }
    }
    for ring in loops {
        for i in 0..ring.len() {
            let (a,b) = (ring[i],ring[(i+1)%ring.len()]);
            let expected = if a < b { (1,0) } else { (0,1) };
            if counts.remove(&(a.min(b),a.max(b))) != Some(expected) { return false; }
        }
    }
    counts.values().all(|&c| c == (1,1))
}

#[cfg(test)]
#[path = "source_boundary_tests.rs"]
mod tests;
