// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The T-junction repair behind [`Mesh::clean_degenerate_watertight`] (#5313).
//!
//! A sub-grid collinear sliver (A, C, M) — M within `h_eps` of the line AC —
//! carries no area, so dropping it is visually lossless. It is not always
//! topologically lossless: when M is a real vertex of the neighbouring
//! triangles (an extrusion's side walls A-M and M-C, the next face of a brep),
//! the neighbours still end at M while the triangle across AC ends at A and C.
//! The surface is open along A-M-C.
//!
//! The repair splits every KEPT triangle on edge AC at the apexes that lie on
//! it, so the far side of AC ends at M as well. It only fires when a kept
//! triangle runs along A-M or M-C. A flap whose apex nothing else uses is just
//! dropped, and so is one whose apex kept triangles only touch elsewhere:
//! splitting AC there would trade one open edge for two. Coincident-pair needles (M within `h_eps` of A or C) are
//! left alone too: their crack is sub-grid, and a split there would make a new
//! needle.
//!
//! Split out of `mesh.rs` (a child module, so it reaches `Mesh` directly) to
//! keep that file inside its module-size budget.

use super::Mesh;
use rustc_hash::FxHashMap;

type Key = [u32; 3];

/// Where the dropped sliver's apex came from, so a neighbour sharing the
/// sliver's own long-edge vertex indices can reuse the apex index instead of
/// growing the vertex buffer.
#[derive(Clone, Copy)]
struct Apex {
    key: Key,
    /// Parameter along the canonical (min key → max key) long edge.
    t: f64,
    /// `(lo, hi, apex)` vertex indices of the sliver that contributed it,
    /// `lo`/`hi` in canonical edge order.
    source: (u32, u32, u32),
}

fn key_of(mesh: &Mesh, i: u32) -> Key {
    let b = i as usize * 3;
    [mesh.positions[b].to_bits(), mesh.positions[b + 1].to_bits(), mesh.positions[b + 2].to_bits()]
}

fn pos_of(mesh: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Split the kept triangles across the long edges of the dropped `slivers`.
/// `kept` is rewritten in place; new vertices (when normals differ) are
/// appended to `mesh`. Returns whether anything was split.
pub(super) fn split_across_dropped_slivers(
    mesh: &mut Mesh,
    kept: &mut Vec<u32>,
    slivers: &[[u32; 3]],
    h_eps: f64,
) -> bool {
    // 1. Each genuine T-vertex sliver names a long edge and an apex on it.
    let mut edges: FxHashMap<(Key, Key), Vec<Apex>> = FxHashMap::default();
    let mut edge_order: Vec<(Key, Key)> = Vec::new();
    for tri in slivers {
        let p = [pos_of(mesh, tri[0]), pos_of(mesh, tri[1]), pos_of(mesh, tri[2])];
        let len = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[0])];
        // Longest edge (i, i+1); apex is the remaining vertex.
        let i = (0..3).fold(0, |m, e| if len[e] > len[m] { e } else { m });
        let (a, c, m) = (tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]);
        let (pa, pc, pm) = (pos_of(mesh, a), pos_of(mesh, c), pos_of(mesh, m));
        if dist(pa, pm) < h_eps || dist(pc, pm) < h_eps {
            continue; // coincident-pair needle, not a T-vertex
        }
        let (ka, kc) = (key_of(mesh, a), key_of(mesh, c));
        let (lo, hi, plo, phi) = if ka <= kc { (a, c, pa, pc) } else { (c, a, pc, pa) };
        let d = [phi[0] - plo[0], phi[1] - plo[1], phi[2] - plo[2]];
        let l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let t = ((pm[0] - plo[0]) * d[0] + (pm[1] - plo[1]) * d[1] + (pm[2] - plo[2]) * d[2]) / l2;
        if !(t > 0.0 && t < 1.0) {
            continue;
        }
        let edge = (key_of(mesh, lo), key_of(mesh, hi));
        let apex = Apex { key: key_of(mesh, m), t, source: (lo, hi, m) };
        let list = edges.entry(edge).or_insert_with(|| {
            edge_order.push(edge);
            Vec::new()
        });
        if !list.iter().any(|x| x.key == apex.key) {
            list.push(apex);
        }
    }
    if edges.is_empty() {
        return false;
    }

    // 2. Only a real T-junction opens the surface: the apex is joined to its
    //    neighbour in the sorted chain A, M1, .., Mk, C by an edge that will
    //    exist in the output — a kept triangle's edge, or the long edge of
    //    another sliver that is itself being repaired (earcut fans a run of
    //    collinear profile vertices into NESTED slivers: A-C split at M, then
    //    A-M split at M'). Grown to a fixpoint; it only ever adds edges, so it
    //    terminates. An apex kept triangles merely touch elsewhere is left
    //    alone: splitting A-C there would trade one open edge for two.
    let canon = |a: Key, b: Key| if a <= b { (a, b) } else { (b, a) };
    let mut joined: rustc_hash::FxHashSet<(Key, Key)> = Default::default();
    for t in kept.chunks_exact(3) {
        for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            joined.insert(canon(key_of(mesh, u), key_of(mesh, v)));
        }
    }
    let mut valid: FxHashMap<(Key, Key), Vec<bool>> = FxHashMap::default();
    for edge in &edge_order {
        let list = edges.get_mut(edge).expect("edge_order mirrors edges");
        list.sort_by(|x, y| x.t.total_cmp(&y.t).then(x.key.cmp(&y.key)));
        valid.insert(*edge, vec![false; list.len()]);
    }
    loop {
        let mut grew = false;
        for edge in &edge_order {
            let list = &edges[edge];
            let chain: Vec<Key> = std::iter::once(edge.0)
                .chain(list.iter().map(|a| a.key))
                .chain(std::iter::once(edge.1))
                .collect();
            let flags = valid.get_mut(edge).expect("valid mirrors edges");
            for i in 1..chain.len() - 1 {
                if !flags[i - 1]
                    && (joined.contains(&canon(chain[i - 1], chain[i]))
                        || joined.contains(&canon(chain[i], chain[i + 1])))
                {
                    flags[i - 1] = true;
                    grew = true;
                }
            }
            if flags.iter().any(|&f| f) && joined.insert(*edge) {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    let mut any = false;
    for edge in &edge_order {
        let mut flags = valid[edge].clone().into_iter();
        let list = edges.get_mut(edge).expect("edge_order mirrors edges");
        list.retain(|_| flags.next().unwrap_or(false));
        any |= !list.is_empty();
    }
    if !any {
        return false;
    }

    // 3. Re-emit the kept triangles, fanning each one that sits on a split edge.
    let mut out: Vec<u32> = Vec::with_capacity(kept.len() + 6);
    let mut split = false;
    for tri in kept.chunks_exact(3) {
        split |= emit(mesh, &edges, [tri[0], tri[1], tri[2]], 0, h_eps, &mut out);
    }
    *kept = out;
    if split {
        // Triangle count and order changed: a stale tag would mis-bucket
        // `consolidate_coplanar` (see `Mesh::plane_tags`).
        mesh.plane_tags = None;
    }
    split
}

/// Push `tri`, split along the first of its edges that carries apexes. Each
/// level consumes one of the triangle's original edges, so three levels cover
/// every edge; the cap is a backstop, not a limit real input reaches.
///
/// A split whose pieces would include a sub-grid sliver is refused and the
/// triangle kept whole (the T-junction stays, as before #5313). That happens
/// when the triangle's third vertex lies on the line of the split edge, e.g. a
/// fan of thin triangles from one far vertex onto a row of collinear points:
/// splitting there would emit exactly the zero-area triangle this pass exists
/// to remove.
fn emit(
    mesh: &mut Mesh,
    edges: &FxHashMap<(Key, Key), Vec<Apex>>,
    tri: [u32; 3],
    depth: u32,
    h_eps: f64,
    out: &mut Vec<u32>,
) -> bool {
    if depth < 4 {
        for e in 0..3 {
            let (u, v, w) = (tri[e], tri[(e + 1) % 3], tri[(e + 2) % 3]);
            let (ku, kv) = (key_of(mesh, u), key_of(mesh, v));
            let forward = ku <= kv;
            let edge = if forward { (ku, kv) } else { (kv, ku) };
            let Some(list) = edges.get(&edge).filter(|l| !l.is_empty()) else {
                continue;
            };
            let ordered: Vec<Apex> =
                if forward { list.clone() } else { list.iter().rev().copied().collect() };
            let pw = pos_of(mesh, w);
            let mut points = vec![pos_of(mesh, u)];
            points.extend(ordered.iter().map(|a| a.key.map(|c| f32::from_bits(c) as f64)));
            points.push(pos_of(mesh, v));
            if points.windows(2).any(|s| height(s[0], s[1], pw) < h_eps) {
                continue;
            }
            let (lo, hi) = if forward { (u, v) } else { (v, u) };
            let mut chain = vec![u];
            for apex in ordered {
                chain.push(apex_vertex(mesh, &apex, lo, hi));
            }
            chain.push(v);
            for s in chain.windows(2) {
                emit(mesh, edges, [s[0], s[1], w], depth + 1, h_eps, out);
            }
            return true;
        }
    }
    out.extend_from_slice(&tri);
    false
}

/// Height of triangle (a, b, c) over its longest edge, the measure
/// `drop_thin_triangles` judges slivers by.
fn height(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let longest = dist(a, b).max(dist(b, c)).max(dist(c, a));
    if longest <= 0.0 {
        return 0.0;
    }
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    let cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt() / longest
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
