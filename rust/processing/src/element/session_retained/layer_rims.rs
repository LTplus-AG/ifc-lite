// SPDX-License-Identifier: MPL-2.0
//! Deterministic rim splits and bounded bit-copy snaps, under the product budget.
use super::{layer_caps::{curved,on}, layer_mesh::*, publication::ShapePart, error::RetainedExecutionError};
use ifc_lite_geometry::program::transactions::LayerInterface;
use std::collections::{BTreeMap,BTreeSet};

pub(super) fn weld_tolerance(is_curved: bool) -> f64 { if is_curved { 1e-3 } else { 1e-6 } }

type Rim = (BTreeSet<(Key,Key)>,Vec<Point>);
fn rim(mesh: &ShapePart, surface: LayerInterface) -> Result<Rim,RetainedExecutionError> {
    let mut edges = BTreeSet::new(); let mut points = BTreeMap::new();
    for (a,b) in boundary(mesh)? {
        let (a,b) = (point(mesh,a),point(mesh,b));
        if on(surface,a) && on(surface,b) {
            edges.insert(edge_key(a,b)); points.insert(key(a),a); points.insert(key(b),b);
        }
    }
    Ok((edges,points.into_values().collect()))
}
fn split(mesh: &mut ShapePart, surface: LayerInterface, others: &[Point], tau: f64) -> Result<f64,RetainedExecutionError> {
    let (edges,_) = rim(mesh,surface)?;
    // Three sorted projections allow output-sensitive interval queries along
    // each edge's longest axis, rather than comparing every triangle pair.
    let sorted: [Vec<Point>;3] = std::array::from_fn(|axis| {
        let mut points = others.to_vec(); points.sort_by(|a,b| a[axis].total_cmp(&b[axis])); points
    });
    let mut output = Vec::new(); let mut faces = Vec::new(); let mut maximum: f64 = 0.;
    let triangles = mesh.indices.clone();
    for (triangle, t) in triangles.chunks_exact(3).enumerate() {
        let face = *mesh.revision_local_faces.get(triangle).ok_or_else(|| fail("face_partition"))?;
        work()?;
        let mut ring = Vec::new();
        for (a,b) in [(t[0],t[1]),(t[1],t[2]),(t[2],t[0])] {
            ring.push(a);
            let (pa,pb) = (point(mesh,a),point(mesh,b));
            if !edges.contains(&edge_key(pa,pb)) { continue; }
            let edge = sub(pb,pa); let length2 = dot(edge,edge);
            let axis = (0..3).max_by(|&i,&j| edge[i].abs().total_cmp(&edge[j].abs())).unwrap();
            let points = &sorted[axis];
            let start = points.partition_point(|p| p[axis] < pa[axis].min(pb[axis])-tau);
            let end = points.partition_point(|p| p[axis] <= pa[axis].max(pb[axis])+tau);
            let mut interior = Vec::new();
            for &p in &points[start..end] {
                work()?;
                let u = dot(sub(p,pa),edge)/length2;
                if u <= 0. || u >= 1. || norm(sub(p,pa)) <= tau || norm(sub(p,pb)) <= tau { continue; }
                let projection = std::array::from_fn(|i| pa[i]+u*edge[i]);
                let distance = norm(sub(p,projection));
                if distance <= tau { interior.push((u,p,distance)); }
            }
            interior.sort_by(|a,b| a.0.total_cmp(&b.0));
            for (_,p,distance) in interior {
                if key(point(mesh,*ring.last().unwrap())) == key(p) { continue; }
                maximum = maximum.max(distance);
                ring.push(append(mesh,p)?);
            }
        }
        if ring.len() == 3 { output.extend_from_slice(t); faces.push(face); continue; }
        // Interior fan preserves every subdivided edge, including splits on
        // two edges of one triangle. An endpoint fan would lose collinear cuts.
        let center = std::array::from_fn(|i| t.iter().map(|&j| point(mesh,j)[i]).sum::<f64>()/3.);
        let center = append(mesh,center)?;
        for i in 0..ring.len() { output.extend([center,ring[i],ring[(i+1)%ring.len()]]); faces.push(face); }
    }
    mesh.indices = output;
    mesh.revision_local_faces = faces;
    Ok(maximum)
}
fn append(mesh: &mut ShapePart, p: Point) -> Result<u32,RetainedExecutionError> {
    let index = u32::try_from(mesh.positions.len()/3).map_err(|_| fail("rim_index_overflow"))?;
    // Charge before every growing allocation, including newly split triangles.
    ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
        work: 1, live_bytes: 96, ..Default::default()
    }).map_err(RetainedExecutionError::Stopped)?.retain();
    mesh.positions.extend(p); Ok(index)
}
pub(super) fn conform(left: &mut ShapePart, right: &mut ShapePart, surface: LayerInterface) -> Result<f64,RetainedExecutionError> {
    let tau = weld_tolerance(curved(surface));
    let (_,a) = rim(left,surface)?; let (_,b) = rim(right,surface)?;
    let mut maximum = split(left,surface,&b,tau)?.max(split(right,surface,&a,tau)?);
    let (_,canonical) = rim(left,surface)?;
    let (_,candidates) = rim(right,surface)?;
    let cell = |p: Point| p.map(|v| (v/tau).floor() as i64);
    let mut grid = BTreeMap::<[i64;3],Vec<Point>>::new();
    for p in canonical { grid.entry(cell(p)).or_default().push(p); }
    let mut snaps = BTreeMap::new();
    for p in candidates {
        let c = cell(p); let mut closest: Option<(f64,Point)> = None;
        for x in -1..=1 { for y in -1..=1 { for z in -1..=1 {
            // Float-to-integer cells saturate at extreme coordinates. A
            // neighbour beyond that range cannot be a stored grid key.
            let (Some(x),Some(y),Some(z)) = (c[0].checked_add(x),c[1].checked_add(y),c[2].checked_add(z)) else { continue; };
            for &q in grid.get(&[x,y,z]).into_iter().flatten() {
                work()?;
                let d = norm(sub(p,q));
                if d <= tau && closest.is_none_or(|(old,_)| d < old) { closest = Some((d,q)); }
            }
        } } }
        let (distance,target) = closest.ok_or_else(|| fail("rim_unmatched"))?;
        maximum = maximum.max(distance); snaps.insert(key(p),target);
    }
    for p in right.positions.chunks_exact_mut(3) {
        if let Some(q) = snaps.get(&key([p[0],p[1],p[2]])) { p.copy_from_slice(q); }
    }
    Ok(maximum)
}
