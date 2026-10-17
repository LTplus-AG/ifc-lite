// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve an isolated thin cell whose three exact edges are supported by
//! healthy source cells. Dropping it opens an actual finite hole (#7292).
use super::{plane_merge::PlaneTri, tri_is_needle};
use crate::Mesh;
use nalgebra::{Point3, Vector3};
use rustc_hash::{FxHashMap, FxHashSet};
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
#[derive(Default)]
pub(super) struct Supported {
    pub buckets: FxHashSet<Bucket>,
    pub cells: FxHashSet<Cell>,
}
pub(super) fn find(buckets: &BTreeMap<Bucket, Vec<PlaneTri>>) -> Supported {
    // Healthy source partitions need no face, edge or certificate tables.
    if !buckets.values().flatten().any(|t| tri_is_needle(&t.v)) {
        return Supported::default();
    }
    let faces = buckets
        .iter()
        .flat_map(|(&key, ts)| ts.iter().map(move |t| (key, t)))
        .collect::<Vec<_>>();
    let needles = faces
        .iter()
        .map(|(_, t)| tri_is_needle(&t.v))
        .collect::<Vec<_>>();
    let mut out = Supported::default();
    // These tables only answer lookups; source/output traversal keeps the
    // caller's ordered bucket map and the original triangle/edge order.
    let mut disjoint = FxHashMap::default();
    if !needles.iter().any(|&n| n) {
        return out;
    }
    let mut edges = FxHashMap::<(Point, Point), Vec<(usize, bool)>>::default();
    for (i, (_, t)) in faces.iter().enumerate() {
        let p = cell_key(&t.v);
        for k in 0..3 {
            let (a, b) = (p[k], p[(k + 1) % 3]);
            edges
                .entry((a.min(b), a.max(b)))
                .or_default()
                .push((i, a < b));
        }
    }
    for (i, (key, t)) in faces.iter().enumerate() {
        if !needles[i] {
            continue;
        }
        let p = cell_key(&t.v);
        let mut neighbors = Vec::new();
        for k in 0..3 {
            let (a, b) = (p[k], p[(k + 1) % 3]);
            if a == b {
                break;
            }
            let incident = &edges[&(a.min(b), a.max(b))];
            if incident.len() != 2 {
                break;
            }
            let Some(&(j, forward)) = incident.iter().find(|&&(j, _)| j != i) else {
                break;
            };
            if forward == (a < b) || needles[j] {
                break;
            }
            neighbors.push(j);
        }
        if neighbors.len() == 3
            && std::iter::once(*key)
                .chain(neighbors.iter().map(|&j| faces[j].0))
                .all(|key| {
                    *disjoint
                        .entry(key)
                        .or_insert_with(|| nonoverlapping(&buckets[&key]))
                })
        {
            out.cells.insert(p);
            out.buckets.insert(*key);
        }
    }
    out
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
