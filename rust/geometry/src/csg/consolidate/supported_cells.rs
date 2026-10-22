// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve thin-cell patches whose complete exact boundary is supported by
//! healthy source cells. Dropping them opens an actual finite hole (#7292, #8047).
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
    pub has_connected_patch: bool,
    // Healthy finite folds remain independent of thin-cell rescue/adoption.
    pub folded_buckets: Vec<Bucket>,
    pub fold_support_buckets: Vec<Bucket>,
}
#[cfg(test)]
pub(super) fn find(buckets: &BTreeMap<Bucket, Vec<PlaneTri>>) -> Supported {
    find_with_folds(buckets, true)
}
#[cfg(test)]
pub(super) fn find_with_folds(buckets: &BTreeMap<Bucket, Vec<PlaneTri>>, preserve_folds: bool) -> Supported {
    find_with_policy(buckets, preserve_folds, true)
}
pub(super) fn find_with_policy(buckets: &BTreeMap<Bucket, Vec<PlaneTri>>, preserve_folds: bool, preserve_connected: bool) -> Supported {
    // Ordinary healthy partitions need no certificate tables. A later cut
    // can keep a finite fold after the original thin seed has been cleaned.
    let has_needle = buckets.values().flatten().any(|t| tri_is_needle(&t.v));
    if !has_needle && (!preserve_folds || !buckets.values().any(|ts| ts.len() == 2
        && healthy_fold_boundary(&[&ts[0], &ts[1]]).is_some())) {
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
    if has_needle {
        retain_supported_patches(&faces, &needles, &edges, buckets, &mut disjoint, &mut out, preserve_connected);
    }
    // A partial source may have boundary edges, but no geometric edge may have
    // repeated uses in either direction. A nonmanifold source cannot certify
    // that retaining these buckets preserves the ordinary cleanup's surface.
    // Thin-cell certificates above remain local and keep their existing policy.
    if !preserve_folds || !edges.values().all(|uses| uses.len() == 1
        || (uses.len() == 2 && uses[0].1 != uses[1].1)) {
        return out;
    }
    // The finite fold's local certificate remains independent of thin cells.
    let mut folded = Vec::new();
    for (first, pair) in faces.windows(2).enumerate() {
        let key = pair[0].0;
        if pair[1].0 != key || buckets[&key].len() != 2 {
            continue;
        }
        let Some(neighbors) = supported_fold_neighbors(first, &faces, &needles, &edges) else {
            continue;
        };
        if std::iter::once(key).chain(neighbors.map(|j| faces[j].0)).all(|key| {
            *disjoint.entry(key).or_insert_with(|| nonoverlapping(&buckets[&key]))
        }) {
            folded.push(key);
            out.fold_support_buckets.extend(neighbors.map(|j| faces[j].0));
        }
    }
    out.buckets.extend(folded.iter().copied());
    out.buckets.extend(out.fold_support_buckets.iter().copied());
    out.folded_buckets = folded;
    out
}

/// The isolated-cell certificate extends to a connected thin patch: internal
/// edges must pair along strictly convex ridges, and every external edge must
/// have a healthy opposite cell. Coplanar fans and concave opening rims keep
/// ordinary cleanup; topology alone does not distinguish those from a feature.
/// Walk iteratively and visit each needle once, including rejected components.
/// A closed all-needle shell has no healthy boundary and cannot certify itself.
fn retain_supported_patches(
    faces: &[(Bucket, &PlaneTri)],
    needles: &[bool],
    edges: &FxHashMap<(Point, Point), Vec<(usize, bool)>>,
    buckets: &BTreeMap<Bucket, Vec<PlaneTri>>,
    disjoint: &mut FxHashMap<Bucket, bool>,
    out: &mut Supported,
    preserve_connected: bool,
) {
    let mut visited = vec![false; faces.len()];
    for start in 0..faces.len() {
        if !needles[start] || visited[start] { continue; }
        let mut pending = vec![start];
        visited[start] = true;
        let mut patch = Vec::new();
        let mut touched = FxHashSet::default();
        let mut valid = true;
        let mut supported_boundary = false;
        while let Some(i) = pending.pop() {
            patch.push(i);
            touched.insert(faces[i].0);
            let p = cell_key(&faces[i].1.v);
            for k in 0..3 {
                let (a, b) = (p[k], p[(k + 1) % 3]);
                let Some(incident) = edges.get(&(a.min(b), a.max(b))) else {
                    valid = false;
                    continue;
                };
                if a == b || incident.len() != 2 {
                    valid = false;
                    continue;
                }
                let Some(&(j, forward)) = incident.iter().find(|&&(j, _)| j != i) else {
                    valid = false;
                    continue;
                };
                if forward == (a < b) { valid = false; }
                touched.insert(faces[j].0);
                if needles[j] {
                    let opposite = faces[j].1.v.iter().find(|p| {
                        let key = point_key(p);
                        key != a && key != b
                    });
                    // Positive orient3d means the opposite vertex is strictly
                    // behind the outward face: a convex exterior ridge.
                    let plane = faces[i].1.v.map(|p| [p.x, p.y, p.z]);
                    let convex = opposite.is_some_and(|p| {
                        plane.iter().flatten().chain(p.iter()).all(|v| v.is_finite())
                            && crate::kernel::predicates::orient3d_explicit(
                                plane[0], plane[1], plane[2], [p.x, p.y, p.z],
                            ) == crate::kernel::Sign::Positive
                    });
                    if !convex { valid = false; }
                    if !visited[j] {
                        visited[j] = true;
                        pending.push(j);
                    }
                } else {
                    supported_boundary = true;
                }
            }
        }
        if valid && supported_boundary && (preserve_connected || patch.len() == 1)
            && touched.into_iter().all(|key| {
            *disjoint.entry(key).or_insert_with(|| nonoverlapping(&buckets[&key]))
        }) {
            out.has_connected_patch |= patch.len() > 1;
            for i in patch {
                out.cells.insert(cell_key(&faces[i].1.v));
                out.buckets.insert(faces[i].0);
            }
        }
    }
}

fn healthy_neighbor(
    own: usize,
    a: Point,
    b: Point,
    needles: &[bool],
    edges: &FxHashMap<(Point, Point), Vec<(usize, bool)>>,
) -> Option<usize> {
    if a == b { return None; }
    let incident = edges.get(&(a.min(b), a.max(b)))?;
    if incident.len() != 2 { return None; }
    let &(j, forward) = incident.iter().find(|&&(j, _)| j != own)?;
    (forward != (a < b) && !needles[j]).then_some(j)
}

/// Boundary cycle of two healthy untagged cells, only when genuinely folded.
/// This local shape alone is NOT permission to bypass planar cleanup.
pub(super) fn healthy_fold_boundary(tris: &[&PlaneTri]) -> Option<[Point; 4]> {
    if tris.len() != 2 || tris.iter().any(|t| t.tag.is_some() || tri_is_needle(&t.v)
        || t.v.iter().flat_map(|p| p.iter()).any(|v| !v.is_finite())) {
        return None;
    }
    let (a, b) = (cell_key(&tris[0].v), cell_key(&tris[1].v));
    for i in 0..3 {
        for j in 0..3 {
            if a[i] == b[(j + 1) % 3] && a[(i + 1) % 3] == b[j] {
                let [p, q, r] = tris[0].v.map(|v| [v.x, v.y, v.z]);
                let s = tris[1].v[(j + 2) % 3];
                if crate::kernel::predicates::orient3d_explicit(p, q, r, [s.x, s.y, s.z])
                    != crate::kernel::Sign::Zero {
                    return Some([a[i], b[(j + 2) % 3], a[(i + 1) % 3], a[(i + 2) % 3]]);
                }
            }
        }
    }
    None
}

fn supported_fold_neighbors(
    first: usize,
    faces: &[(Bucket, &PlaneTri)],
    needles: &[bool],
    edges: &FxHashMap<(Point, Point), Vec<(usize, bool)>>,
) -> Option<[usize; 4]> {
    let key = faces[first].0;
    let boundary = healthy_fold_boundary(&[faces[first].1, faces[first + 1].1])?;
    let (a, b) = (boundary[0], boundary[2]);
    let internal = edges.get(&(a.min(b), a.max(b)))?;
    if internal.len() != 2 || !internal.iter().any(|&(j, _)| j == first)
        || !internal.iter().any(|&(j, _)| j == first + 1) {
        return None;
    }
    let mut neighbors = [0; 4];
    for k in 0..4 {
        let (a, b) = (boundary[k], boundary[(k + 1) % 4]);
        let incident = edges.get(&(a.min(b), a.max(b)))?;
        let own = if k < 2 { first + 1 } else { first };
        if incident.len() != 2 || incident.iter().filter(|&&(j, _)| j == own).count() != 1 {
            return None;
        }
        let j = healthy_neighbor(own, a, b, needles, edges)?;
        if j == first || j == first + 1 || faces[j].0 == key {
            return None;
        }
        neighbors[k] = j;
    }
    // Four distinct external cells must support the complete boundary. Two
    // adjacent supports must also preserve its source chain in one bucket.
    if (0..4).any(|k| neighbors[..k].contains(&neighbors[k])) { return None; }
    let anchored = (0..4).any(|k| {
        faces[neighbors[k]].0 == faces[neighbors[(k + 1) % 4]].0
    });
    anchored.then_some(neighbors)
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
pub(super) fn nonoverlapping(tris: &[PlaneTri]) -> bool {
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
    let orient = crate::math::geom2d::orientation;
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
