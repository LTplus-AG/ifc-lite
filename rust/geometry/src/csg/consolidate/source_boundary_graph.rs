// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact source topology for the optional boundary-preserving retry.
use super::plane_merge::PlaneTri;
use nalgebra::Point3;
use std::collections::{BTreeMap, BTreeSet};

type Edge = (usize, usize);
type Use = (usize, usize, usize);
pub(super) struct Partition {
    pub points: Vec<Point3<f64>>,
    pub faces: Vec<[usize; 3]>,
    pub components: Vec<Vec<usize>>,
}

fn key(p: &Point3<f64>) -> [u64; 3] {
    [p.x, p.y, p.z].map(|x| if x == 0.0 { 0 } else { x.to_bits() })
}

/// Only exact opposed EDGES join faces. Vertex-touching sheets remain separate
/// components; duplicate, same-direction and nonmanifold edge uses refuse.
pub(super) fn partition(tris: &[PlaneTri]) -> Option<Partition> {
    let mut points = Vec::new();
    let mut ids = BTreeMap::new();
    let mut faces = Vec::with_capacity(tris.len());
    let mut edges = BTreeMap::<Edge, Vec<Use>>::new();
    for (face, tri) in tris.iter().enumerate() {
        let mut indices = [0; 3];
        for (i, p) in tri.v.iter().enumerate() {
            if p.iter().any(|v| !v.is_finite()) { return None; }
            indices[i] = *ids.entry(key(p)).or_insert_with(|| {
                let id = points.len(); points.push(*p); id
            });
        }
        for i in 0..3 {
            let (a,b) = (indices[i], indices[(i+1)%3]);
            if a == b { return None; }
            edges.entry((a.min(b), a.max(b))).or_default().push((face,a,b));
        }
        faces.push(indices);
    }
    let mut adjacent = vec![Vec::new(); faces.len()];
    for uses in edges.values() {
        match uses.as_slice() {
            [_] => {},
            [(f,a,b),(g,c,d)] if a == d && b == c && f != g => {
                adjacent[*f].push(*g); adjacent[*g].push(*f);
            },
            _ => return None,
        }
    }
    let mut visited = vec![false; faces.len()];
    let mut components = Vec::new();
    for start in 0..faces.len() {
        if visited[start] { continue; }
        let mut component = Vec::new();
        let mut pending = vec![start];
        visited[start] = true;
        while let Some(face) = pending.pop() {
            component.push(face);
            for &other in &adjacent[face] {
                if !visited[other] { visited[other] = true; pending.push(other); }
            }
        }
        component.sort_unstable();
        components.push(component);
    }
    Some(Partition { points, faces, components })
}

/// Cancel only opposed original edges, then require directed degree one.
/// Every surviving segment is retained verbatim, including collinear corners.
pub(super) fn rings(faces: &[[usize; 3]], component: &[usize]) -> Option<Vec<Vec<usize>>> {
    let mut edges = BTreeSet::new();
    for &face in component {
        let t = faces[face];
        for i in 0..3 {
            let (a,b) = (t[i],t[(i+1)%3]);
            if !edges.remove(&(b,a)) && !edges.insert((a,b)) { return None; }
        }
    }
    let mut next = BTreeMap::new();
    let mut incoming = BTreeSet::new();
    for (a,b) in edges {
        if next.insert(a,b).is_some() || !incoming.insert(b) { return None; }
    }
    if next.is_empty() || next.keys().any(|p| !incoming.contains(p)) { return None; }
    let mut result = Vec::new();
    while let Some((&start,_)) = next.first_key_value() {
        let mut ring = Vec::new();
        let mut p = start;
        loop {
            ring.push(p);
            p = next.remove(&p)?;
            if p == start { break; }
        }
        if ring.len() < 3 { return None; }
        result.push(ring);
    }
    Some(result)
}
