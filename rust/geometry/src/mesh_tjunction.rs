// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The sliver rule shared by [`Mesh::drop_thin_triangles`] and the T-junction
//! repair behind [`Mesh::clean_degenerate_watertight`] (#5313).
//!
//! A sub-grid collinear sliver (A, C, M) carries no area, so dropping it is
//! visually lossless. It is not always topologically lossless: when M is a
//! real vertex of the neighbouring triangles (an extrusion's side walls A-M and
//! M-C, the next face of a brep), the neighbours end at M while the triangle
//! across AC ends at A and C, and the surface is open along A-M-C. The repair
//! splits the kept triangle across AC at M.

use super::Mesh;
use rustc_hash::{FxHashMap, FxHashSet};

type Key = [u32; 3];

/// Canonical (sorted) form of an undirected edge.
fn canon(a: Key, b: Key) -> (Key, Key) {
    if a <= b { (a, b) } else { (b, a) }
}

fn key_of(mesh: &Mesh, i: u32) -> Key {
    let b = i as usize * 3;
    [mesh.positions[b].to_bits(), mesh.positions[b + 1].to_bits(), mesh.positions[b + 2].to_bits()]
}

pub(super) fn pos_of(mesh: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Height of triangle (a, b, c) over its longest edge (= 2·area / longest),
/// the measure a sliver is judged by. `None` when all three points coincide.
pub(super) fn height(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<f64> {
    let longest = dist(a, b).max(dist(b, c)).max(dist(c, a));
    if longest <= 0.0 {
        return None;
    }
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    let cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    Some((cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt() / longest)
}

/// One dropped sliver's apex on its long edge.
#[derive(Clone, Copy)]
struct Apex {
    key: Key,
    /// Parameter along the canonical (min key → max key) long edge.
    t: f64,
    /// `(lo, hi, apex)` vertex indices of the sliver that contributed it,
    /// `lo`/`hi` in canonical edge order, so a triangle sharing the sliver's
    /// own edge indices can reuse the apex index.
    source: (u32, u32, u32),
    /// Joined to its neighbour on the long edge by an edge the output will
    /// have; only such apexes are split at.
    valid: bool,
}

/// A long edge and the apexes on it, sorted along the edge.
struct LongEdge {
    edge: (Key, Key),
    apexes: Vec<Apex>,
}

impl LongEdge {
    /// `edge.0, apex keys.., edge.1`.
    fn chain(&self) -> Vec<Key> {
        std::iter::once(self.edge.0)
            .chain(self.apexes.iter().map(|a| a.key))
            .chain(std::iter::once(self.edge.1))
            .collect()
    }
}

/// Split the kept triangles across the long edges of the dropped `slivers`.
/// `kept` is rewritten in place; an apex copy (when normals differ) is
/// appended to `mesh`.
pub(super) fn split_across_dropped_slivers(
    mesh: &mut Mesh,
    kept: &mut Vec<u32>,
    slivers: &[[u32; 3]],
    h_eps: f64,
) {
    // 1. Each T-vertex sliver names a long edge and an apex strictly inside
    //    it. Coincident-pair needles (apex within `h_eps` of an end) are left
    //    alone: their crack is sub-grid, and a split there would make a new
    //    needle. Insertion order, never hash order, decides the output.
    let mut long_edges: Vec<LongEdge> = Vec::new();
    let mut index_of: FxHashMap<(Key, Key), usize> = FxHashMap::default();
    for tri in slivers {
        let p = tri.map(|i| pos_of(mesh, i));
        let len = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[0])];
        let i = (0..3).fold(0, |m, e| if len[e] > len[m] { e } else { m });
        let (a, c, m) = (tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]);
        let (pa, pc, pm) = (p[i], p[(i + 1) % 3], p[(i + 2) % 3]);
        if dist(pa, pm) < h_eps || dist(pc, pm) < h_eps {
            continue;
        }
        let (ka, kc) = (key_of(mesh, a), key_of(mesh, c));
        let (lo, hi, plo, phi) = if ka <= kc { (a, c, pa, pc) } else { (c, a, pc, pa) };
        let d = [phi[0] - plo[0], phi[1] - plo[1], phi[2] - plo[2]];
        let l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let t = ((pm[0] - plo[0]) * d[0] + (pm[1] - plo[1]) * d[1] + (pm[2] - plo[2]) * d[2]) / l2;
        if !(t > 0.0 && t < 1.0) {
            continue;
        }
        let edge = canon(ka, kc);
        let slot = *index_of.entry(edge).or_insert_with(|| {
            long_edges.push(LongEdge { edge, apexes: Vec::new() });
            long_edges.len() - 1
        });
        let apex = Apex { key: key_of(mesh, m), t, source: (lo, hi, m), valid: false };
        let list = &mut long_edges[slot].apexes;
        if !list.iter().any(|x| x.key == apex.key) {
            list.push(apex);
        }
    }
    if long_edges.is_empty() {
        return;
    }
    for le in &mut long_edges {
        le.apexes.sort_by(|x, y| x.t.total_cmp(&y.t).then(x.key.cmp(&y.key)));
    }

    // Only vertices on some chain can take part in a split; mark them once so
    // the rest of the mesh costs one key per vertex, not six per triangle.
    let chain_keys: FxHashSet<Key> = long_edges.iter().flat_map(LongEdge::chain).collect();
    let on_chain: Vec<bool> =
        (0..mesh.positions.len() as u32 / 3).map(|i| chain_keys.contains(&key_of(mesh, i))).collect();

    // 2. Only a real T-junction opens the surface: the apex is joined to its
    //    neighbour in the chain A, M1, .., Mk, C by an edge that will exist in
    //    the output — a kept triangle's edge, or the long edge of another
    //    sliver that is itself being repaired (earcut fans a run of collinear
    //    points into NESTED slivers: A-C split at M, then A-M split at M').
    //    Grown to a fixpoint; it only ever adds edges, so it terminates. An
    //    apex kept triangles merely touch elsewhere is left alone: splitting
    //    A-C there would trade one open edge for two.
    let mut joined: FxHashSet<(Key, Key)> = FxHashSet::default();
    for t in kept.chunks_exact(3) {
        for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            if on_chain[u as usize] && on_chain[v as usize] {
                joined.insert(canon(key_of(mesh, u), key_of(mesh, v)));
            }
        }
    }
    let chains: Vec<Vec<Key>> = long_edges.iter().map(LongEdge::chain).collect();
    loop {
        let mut grew = false;
        for (le, chain) in long_edges.iter_mut().zip(&chains) {
            for i in 1..chain.len() - 1 {
                let apex = &mut le.apexes[i - 1];
                if !apex.valid
                    && (joined.contains(&canon(chain[i - 1], chain[i]))
                        || joined.contains(&canon(chain[i], chain[i + 1])))
                {
                    apex.valid = true;
                    grew = true;
                }
            }
            if le.apexes.iter().any(|a| a.valid) && joined.insert(le.edge) {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    let splits: FxHashMap<(Key, Key), Vec<Apex>> = long_edges
        .into_iter()
        .filter_map(|le| {
            let valid: Vec<Apex> = le.apexes.into_iter().filter(|a| a.valid).collect();
            (!valid.is_empty()).then_some((le.edge, valid))
        })
        .collect();
    if splits.is_empty() {
        return;
    }

    // 3. Re-emit the kept triangles, fanning each one that sits on a split edge.
    let mut out: Vec<u32> = Vec::with_capacity(kept.len() + 6);
    let mut split = false;
    for tri in kept.chunks_exact(3) {
        let tri = [tri[0], tri[1], tri[2]];
        if tri.iter().filter(|&&i| on_chain[i as usize]).count() < 2 {
            out.extend_from_slice(&tri); // no edge can lie on a long edge
            continue;
        }
        split |= emit(mesh, &splits, tri, 0, h_eps, &mut out);
    }
    *kept = out;
    if split {
        // Triangle count and order changed: a stale tag would mis-bucket
        // `consolidate_coplanar` (see `Mesh::plane_tags`).
        mesh.plane_tags = None;
    }
}

/// Push `tri`, split along the first of its edges that carries apexes. Each
/// level consumes one of the triangle's original edges, so three levels cover
/// every edge; the cap is a backstop, not a limit real input reaches.
///
/// A split whose pieces would include a sub-grid sliver is refused and the
/// triangle kept whole (the T-junction stays). That happens when the
/// triangle's third vertex lies on the line of the split edge, e.g. a fan of
/// thin triangles from one far vertex onto a row of collinear points:
/// splitting there would emit exactly the zero-area triangle this pass exists
/// to remove.
fn emit(
    mesh: &mut Mesh,
    splits: &FxHashMap<(Key, Key), Vec<Apex>>,
    tri: [u32; 3],
    depth: u32,
    h_eps: f64,
    out: &mut Vec<u32>,
) -> bool {
    if depth < 4 {
        for e in 0..3 {
            let (u, v, w) = (tri[e], tri[(e + 1) % 3], tri[(e + 2) % 3]);
            let (ku, kv) = (key_of(mesh, u), key_of(mesh, v));
            let Some(list) = splits.get(&canon(ku, kv)) else {
                continue;
            };
            let forward = ku <= kv;
            let ordered: Vec<Apex> =
                if forward { list.clone() } else { list.iter().rev().copied().collect() };
            let pw = pos_of(mesh, w);
            let mut points = vec![pos_of(mesh, u)];
            points.extend(ordered.iter().map(|a| a.key.map(|c| f32::from_bits(c) as f64)));
            points.push(pos_of(mesh, v));
            if points.windows(2).any(|s| height(s[0], s[1], pw).is_none_or(|h| h < h_eps)) {
                continue;
            }
            let (lo, hi) = if forward { (u, v) } else { (v, u) };
            let mut chain = vec![u];
            for apex in ordered {
                chain.push(apex_vertex(mesh, &apex, lo, hi));
            }
            chain.push(v);
            for s in chain.windows(2) {
                emit(mesh, splits, [s[0], s[1], w], depth + 1, h_eps, out);
            }
            return true;
        }
    }
    out.extend_from_slice(&tri);
    false
}

/// The vertex index to use for `apex` inside a triangle whose split edge runs
/// `lo` → `hi` (canonical order). Reuses the sliver's own apex when the
/// triangle shares the sliver's edge indices (same face, same attributes) or
/// the mesh carries no normals; otherwise appends a copy at the apex's exact
/// position with the normal interpolated along the edge.
fn apex_vertex(mesh: &mut Mesh, apex: &Apex, lo: u32, hi: u32) -> u32 {
    let has_normals = mesh.normals.len() == mesh.positions.len();
    if !has_normals || (apex.source.0 == lo && apex.source.1 == hi) {
        return apex.source.2;
    }
    let n = |i: u32| {
        let b = i as usize * 3;
        [mesh.normals[b] as f64, mesh.normals[b + 1] as f64, mesh.normals[b + 2] as f64]
    };
    let (nl, nh) = (n(lo), n(hi));
    let mix = [0, 1, 2].map(|k| nl[k] + (nh[k] - nl[k]) * apex.t);
    let len = (mix[0] * mix[0] + mix[1] * mix[1] + mix[2] * mix[2]).sqrt();
    let normal = if len > 1e-12 { mix.map(|c| c / len) } else { nl };
    let index = (mesh.positions.len() / 3) as u32;
    mesh.positions.extend(apex.key.map(f32::from_bits));
    mesh.normals.extend(normal.map(|c| c as f32));
    index
}
