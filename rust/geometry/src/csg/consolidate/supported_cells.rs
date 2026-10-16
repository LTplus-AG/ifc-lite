// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve an isolated thin cell whose three exact edges are supported by
//! healthy source cells. Dropping it opens an actual finite hole (#7292).
use super::{plane_merge::PlaneTri, tri_is_needle};
use crate::Mesh;
use nalgebra::{Point3, Vector3};
use std::collections::BTreeMap;
type Bucket = (i64, i64, i64, i64);
type Point = [u64; 3];
type Cell = [Point; 3];
fn point_key(p: &Point3<f64>) -> Point {
    [p.x, p.y, p.z].map(|v| if v == 0.0 { 0 } else { v.to_bits() })
}
pub(super) fn cell_key(t: &[Point3<f64>; 3]) -> Cell {
    t.map(|p| point_key(&p))
}
/// Lookup-only sorted membership; source traversal never follows these keys.
#[derive(Default)]
pub(super) struct SortedKeys<T> {
    keys: Vec<T>,
}
impl<T: Ord> SortedKeys<T> {
    fn from_unsorted(mut keys: Vec<T>) -> Self {
        keys.sort_unstable();
        keys.dedup();
        Self { keys }
    }
    pub(super) fn contains(&self, key: &T) -> bool {
        self.keys.binary_search(key).is_ok()
    }
}
impl<T> SortedKeys<T> {
    pub(super) fn is_empty(&self) -> bool { self.keys.is_empty() }
    #[cfg(test)]
    pub(super) fn len(&self) -> usize { self.keys.len() }
}
#[derive(Default)]
pub(super) struct Supported {
    pub buckets: SortedKeys<Bucket>,
    pub cells: SortedKeys<Cell>,
}

fn edge_key(cells: &[Cell], edge: usize) -> (Point, Point) {
    let cell = &cells[edge / 3];
    let (a, b) = (cell[edge % 3], cell[(edge % 3 + 1) % 3]);
    (a.min(b), a.max(b))
}

/// Sort source-edge ordinals, rather than copying wide keys into a hash table.
/// Only exactly two opposite uses on distinct faces supply a neighbor. Ties
/// need no ordering: the two source slots are filled symmetrically.
fn opposite_neighbors(cells: &[Cell]) -> Vec<[Option<usize>; 3]> {
    let mut edges: Vec<usize> = (0..cells.len() * 3).collect();
    edges.sort_unstable_by(|&a, &b| edge_key(cells, a).cmp(&edge_key(cells, b)));
    let mut neighbors = vec![[None; 3]; cells.len()];
    let mut start = 0;
    while start < edges.len() {
        let key = edge_key(cells, edges[start]);
        let mut end = start + 1;
        while end < edges.len() && edge_key(cells, edges[end]) == key { end += 1; }
        if end - start == 2 && key.0 != key.1 {
            let (a, b) = (edges[start], edges[start + 1]);
            let forward = |e: usize| cells[e / 3][e % 3] < cells[e / 3][(e % 3 + 1) % 3];
            if a / 3 != b / 3 && forward(a) != forward(b) {
                neighbors[a / 3][a % 3] = Some(b / 3);
                neighbors[b / 3][b % 3] = Some(a / 3);
            }
        }
        start = end;
    }
    neighbors
}

pub(super) fn find(buckets: &BTreeMap<Bucket, Vec<PlaneTri>>) -> Supported {
    // Ordinary buckets need no source/edge tables at all. A rescue still uses
    // the unchanged predicate for every face before accepting any neighbor.
    if !buckets.values().flatten().any(|t| tri_is_needle(&t.v)) {
        return Supported::default();
    }
    let ordered_buckets: Vec<_> = buckets.iter().collect();
    let faces: Vec<_> = ordered_buckets.iter().enumerate()
        .flat_map(|(bid, (_, ts))| ts.iter().map(move |t| (bid, t)))
        .collect();
    let needles: Vec<_> = faces.iter().map(|(_, t)| tri_is_needle(&t.v)).collect();
    let cells: Vec<_> = faces.iter().map(|(_, t)| cell_key(&t.v)).collect();
    let neighbors = opposite_neighbors(&cells);
    let mut disjoint = vec![None; ordered_buckets.len()];
    let mut supported_cells = Vec::new();
    let mut supported_buckets = Vec::new();
    // Source traversal, supporting-edge order and lazy certificate order stay
    // unchanged. Ordinals only replace lookup keys; they never choose output.
    for (i, &(bid, _)) in faces.iter().enumerate() {
        if !needles[i] { continue; }
        let mut healthy = Vec::new();
        for &neighbor in &neighbors[i] {
            let Some(j) = neighbor else { break; };
            if needles[j] { break; }
            healthy.push(j);
        }
        if healthy.len() == 3
            && std::iter::once(bid)
                .chain(healthy.iter().map(|&j| faces[j].0))
                .all(|bid| *disjoint[bid].get_or_insert_with(|| nonoverlapping(ordered_buckets[bid].1)))
        {
            supported_cells.push(cells[i]);
            supported_buckets.push(*ordered_buckets[bid].0);
        }
    }
    Supported {
        buckets: SortedKeys::from_unsorted(supported_buckets),
        cells: SortedKeys::from_unsorted(supported_cells),
    }
}
pub(super) fn append(mesh: &mut Mesh, t: &[Point3<f64>; 3], normal: &Vector3<f64>) {
    let base = mesh.vertex_count() as u32;
    for &p in t {
        mesh.add_vertex(p, *normal);
    }
    mesh.add_triangle(base, base + 1, base + 2);
}
pub(super) fn append_mesh(mesh: &mut Mesh, other: &Mesh) {
    for t in other.indices.chunks_exact(3) {
        let p = [t[0], t[1], t[2]].map(|i| {
            let b = i as usize * 3;
            Point3::new(
                other.positions[b] as f64,
                other.positions[b + 1] as f64,
                other.positions[b + 2] as f64,
            )
        });
        let b = t[0] as usize * 3;
        let n = Vector3::new(
            other.normals[b] as f64,
            other.normals[b + 1] as f64,
            other.normals[b + 2] as f64,
        );
        append(mesh, &p, &n);
    }
}

/// Retention may rescue only the certified cells. In particular, the existing
/// whole-raw fallback must not bring unrelated import needles back (#1007).
pub(super) fn has_uncertified_needle(mesh: &Mesh, supported: &Supported) -> bool {
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) {
        return true;
    }
    mesh.indices.chunks_exact(3).any(|tri| {
        if tri.iter().any(|&i| i as usize >= mesh.vertex_count()) {
            return true;
        }
        let points = [tri[0], tri[1], tri[2]].map(|i| {
            let b = i as usize * 3;
            Point3::new(
                mesh.positions[b] as f64,
                mesh.positions[b + 1] as f64,
                mesh.positions[b + 2] as f64,
            )
        });
        points.iter().flat_map(|p| p.iter()).any(|v| !v.is_finite())
            || (tri_is_needle(&points) && !supported.cells.contains(&cell_key(&points)))
    })
}

// Bypassing a bucket's NonZero union is valid only when its complete source
// partition has no positive-area projected overlap. Exact SAT permits shared
// vertices/edges, rejects duplicates and opposite-wound overlaps. Bound this
// optional certificate's pair work; a large bucket retains ordinary cleanup.
fn nonoverlapping(tris: &[PlaneTri]) -> bool {
    if tris.len().saturating_mul(tris.len().saturating_sub(1)) / 2 > 4096 {
        return false;
    }
    if tris.is_empty()
        || tris.iter().any(|t| {
            t.v.iter()
                .flat_map(|p| p.iter())
                .chain(t.normal.iter())
                .any(|v| !v.is_finite())
        })
    {
        return false;
    }
    let n = tris[0].normal.map(f64::abs);
    let (x, y) = if n.x >= n.y && n.x >= n.z {
        (1, 2)
    } else if n.y >= n.z {
        (2, 0)
    } else {
        (0, 1)
    };
    let project = |t: &PlaneTri| t.v.map(|p| [p[x], p[y]]);
    let orient = crate::geom2d::orientation;
    for (i, a) in tris.iter().enumerate() {
        let a = project(a);
        let wa = orient(a[0], a[1], a[2]);
        if wa == 0 {
            return false;
        }
        for b in &tris[i + 1..] {
            let b = project(b);
            let wb = orient(b[0], b[1], b[2]);
            if wb == 0 {
                return false;
            }
            let separated = |a: [[f64; 2]; 3], b: [[f64; 2]; 3], w: i32| {
                (0..3).any(|k| b.iter().all(|&p| orient(a[k], a[(k + 1) % 3], p) != w))
            };
            if !separated(a, b, wa) && !separated(b, a, wb) {
                return false;
            }
        }
    }
    true
}
#[cfg(test)]
#[path = "supported_cells_tests.rs"]
mod tests;
