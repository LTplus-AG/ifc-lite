// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The watertight sliver-bisection pass behind
//! [`super::refine_high_aspect_slivers`] and
//! [`super::refine_high_aspect_slivers_within`]. Split out of `facet_weld.rs`
//! for the module-size ratchet; the two public wrappers and their docs stay
//! there.

use super::{dedup_key, snap_grid, tri_normal};
use crate::mesh::Mesh;
use std::collections::BTreeMap;

/// Max output-triangle aspect ratio tolerated before [`refine_high_aspect_slivers`]
/// bisects it. 8:1 matches the #1007 success bar; well-shaped cut triangles are
/// far below it, so the pass is a no-op on clean output.
const SLIVER_ASPECT: f64 = 8.0;

/// Absolute cap on bisection rounds so the pass always terminates fast and never
/// explodes triangle count on a pathological mesh.
const MAX_BISECT_ROUNDS: usize = 64;

/// Aspect ratio (longest / shortest edge) of a triangle, `INFINITY` if degenerate.
#[inline]
fn aspect(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let d = |p: [f64; 3], q: [f64; 3]| {
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };
    let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if mn > 1.0e-9 {
        mx / mn
    } else {
        f64::INFINITY
    }
}

pub(super) fn refine_high_aspect_slivers_impl(
    mesh: &Mesh,
    region: Option<&[([f64; 3], [f64; 3])]>,
) -> Mesh {
    let vertex_count = mesh.positions.len() / 3;
    if vertex_count < 3 || mesh.indices.len() < 6 {
        return mesh.clone();
    }

    // RAW NO-SLIVER PRE-SCAN (perf; Holter-class hosts fire the prism void
    // fast path on hundreds of clean cuts): the canonicalization below hashes
    // every vertex BEFORE the existing no-sliver fast path can fire, so a
    // clean cut still paid an O(V) hash build per call. Scan the raw f64
    // triangles first with a CONSERVATIVE margin: a canonical (deduped)
    // position differs from its raw one by at most one dedup cell
    // (≤ √3·POSITION_DEDUP_GRID per endpoint, so ≤ 2·√3·POSITION_DEDUP_GRID
    // per edge length), so any triangle whose canonical aspect could exceed
    // SLIVER_ASPECT is caught by widening the raw test by EDGE_SLACK. A raw
    // "maybe" just falls through to the exact canonical scan below; a raw
    // "clean" is proof the canonical scan would find nothing, so returning
    // the input unchanged here is byte-identical to that no-op path.
    const EDGE_SLACK: f64 = 4.0e-4; // > 2·√3·POSITION_DEDUP_GRID
    // TWO paddings, because the raw pre-scan and the canonical scans test
    // DIFFERENT coordinates against the same caller boxes:
    //   - canonical scans use `cpos` (deduped) → EDGE_SLACK.
    //   - the raw pre-scan uses the mesh's raw f64 → 2·EDGE_SLACK.
    // Canonicalization can move a vertex up to one dedup cell (√3·grid) INTO
    // the region, so a triangle sitting raw-OUTSIDE the once-padded box can be
    // canonically INSIDE it. With only one padding the pre-scan would answer
    // "no sliver here" for a triangle the canonical scan would have refined —
    // silently disabling the #1007 rim repair for it. The wider raw box makes
    // the pre-scan's "clean" verdict a genuine proof again, which is what lets
    // it early-out byte-identically.
    let pad_region = |slack: f64| -> Option<Vec<([f64; 3], [f64; 3])>> {
        region.map(|boxes| {
            boxes
                .iter()
                .map(|(lo, hi)| {
                    (
                        [lo[0] - slack, lo[1] - slack, lo[2] - slack],
                        [hi[0] + slack, hi[1] + slack, hi[2] + slack],
                    )
                })
                .collect()
        })
    };
    let padded_region = pad_region(EDGE_SLACK);
    let prescan_region = pad_region(2.0 * EDGE_SLACK);
    let tri_in_boxes = |boxes: Option<&[([f64; 3], [f64; 3])]>,
                        a: [f64; 3],
                        b: [f64; 3],
                        c: [f64; 3]|
     -> bool {
        let Some(boxes) = boxes else {
            return true;
        };
        let lo = [
            a[0].min(b[0]).min(c[0]),
            a[1].min(b[1]).min(c[1]),
            a[2].min(b[2]).min(c[2]),
        ];
        let hi = [
            a[0].max(b[0]).max(c[0]),
            a[1].max(b[1]).max(c[1]),
            a[2].max(b[2]).max(c[2]),
        ];
        boxes
            .iter()
            .any(|(blo, bhi)| (0..3).all(|k| lo[k] <= bhi[k] && hi[k] >= blo[k]))
    };
    let tri_in_region = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| -> bool {
        tri_in_boxes(padded_region.as_deref(), a, b, c)
    };
    let raw_may_have_sliver = mesh.indices.chunks_exact(3).any(|c| {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            return false; // the canonical tri build drops it too
        }
        let p = |i: usize| -> [f64; 3] {
            [
                mesh.positions[i * 3] as f64,
                mesh.positions[i * 3 + 1] as f64,
                mesh.positions[i * 3 + 2] as f64,
            ]
        };
        let (a, b, c3) = (p(i0), p(i1), p(i2));
        // Raw coordinates ⇒ the WIDER pre-scan boxes (see pad_region above).
        if !tri_in_boxes(prescan_region.as_deref(), a, b, c3) {
            return false;
        }
        let d = |x: [f64; 3], y: [f64; 3]| {
            ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c3), d(c3, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        // A short-min-edge triangle may canonically merge (dropped) or snap to
        // aspect INFINITY; either way it must take the exact scan.
        mn - EDGE_SLACK <= 1.0e-9 || (mx + EDGE_SLACK) > SLIVER_ASPECT * (mn - EDGE_SLACK)
    });
    if !raw_may_have_sliver {
        return mesh.clone();
    }

    // Canonicalise vertices by snapped position so a shared edge is ONE key.
    let pos = |i: usize| -> [f64; 3] {
        [
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ]
    };
    let mut canon_of: Vec<usize> = vec![0; vertex_count];
    let mut cpos: Vec<[f64; 3]> = Vec::new();
    {
        // FxHashMap (canonical ids are insertion-ordered via `cpos.len()`, the
        // map is only queried by key — output identical, no tree-balance cost).
        let mut seen: rustc_hash::FxHashMap<(i64, i64, i64), usize> =
            rustc_hash::FxHashMap::default();
        for i in 0..vertex_count {
            let p = pos(i);
            let key = (dedup_key(p[0]), dedup_key(p[1]), dedup_key(p[2]));
            let id = *seen.entry(key).or_insert_with(|| {
                let id = cpos.len();
                cpos.push(p);
                id
            });
            canon_of[i] = id;
        }
    }

    // Triangles as canonical-id triples; drop degenerate / out-of-range.
    let mut tris: Vec<[usize; 3]> = Vec::with_capacity(mesh.indices.len() / 3);
    for c in mesh.indices.chunks_exact(3) {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let (a, b, d) = (canon_of[i0], canon_of[i1], canon_of[i2]);
        if a == b || b == d || a == d {
            continue;
        }
        tris.push([a, b, d]);
    }

    let edge_key = |u: usize, v: usize| -> (usize, usize) {
        if u < v {
            (u, v)
        } else {
            (v, u)
        }
    };

    // Fast path (common case: a clean cut leaves no slivers). A split only fires
    // for a triangle whose aspect exceeds SLIVER_ASPECT; if none does, the round
    // loop would build its edge map, find nothing, and return the mesh unchanged.
    // One O(T) scan detects that and skips it — byte-identical to that no-op.
    if !tris.iter().any(|t| {
        aspect(cpos[t[0]], cpos[t[1]], cpos[t[2]]) > SLIVER_ASPECT
            && tri_in_region(cpos[t[0]], cpos[t[1]], cpos[t[2]])
    }) {
        return mesh.clone();
    }

    let mut changed_any = false;
    // SCOPED-mode split budget. The unscoped loop is inherently bounded (ONE
    // split per round × MAX_BISECT_ROUNDS). The scoped batched loop splits many
    // edges per round, so a triangle that bisection cannot improve — a
    // DEGENERATE needle (aspect INFINITY: its min edge survives every split)
    // — would re-qualify every round and DOUBLE its fragments each time.
    // Guard twice: scoped candidacy requires a FINITE aspect (splitting an
    // INFINITY needle never helps; `clean_degenerate` drops it downstream),
    // and a hard cap on total splits bounds the worst case regardless.
    const MAX_SCOPED_SPLITS: usize = 2048;
    let mut splits_done = 0usize;
    for _round in 0..MAX_BISECT_ROUNDS {
        // Build edge → incident triangle indices (deterministic BTreeMap).
        let mut edge_tris: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
        for (ti, t) in tris.iter().enumerate() {
            for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                edge_tris.entry(edge_key(u, v)).or_default().push(ti);
            }
        }

        // Collect this round's split edges — lowest-keyed long edges of
        // triangles over the aspect threshold. Deterministic (BTreeMap order).
        //
        // UNSCOPED (`region == None`, the exact-kernel caller): exactly ONE
        // edge per round — the original, byte-pinned behavior.
        //
        // SCOPED (the prism void fast path): every qualifying edge whose
        // incident triangles are not already claimed this round. A rim cut on
        // a thin host emits DOZENS of independent reveal slivers per element;
        // fixing one edge per round re-built this whole edge map once per
        // split (the Holter 4.1.x void fast-path regression). Batching
        // disjoint splits keeps the lockstep-midpoint watertightness argument
        // per edge (each triangle splits at most once per round, both
        // incident triangles split at the same snapped midpoint) and stays
        // deterministic (BTreeMap iteration order; midpoint ids assigned in
        // that same order).
        let mut round_edges: Vec<(usize, usize)> = Vec::new();
        let mut claimed: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
        'outer: for (ek, incident) in &edge_tris {
            // Only split a manifold (2-incident) or boundary (1-incident) edge;
            // a non-manifold (>2) edge is skipped (splitting it can't stay
            // watertight without splitting all incident tris in lockstep, and
            // such edges don't occur on a clean cut sliver).
            if incident.len() > 2 {
                continue;
            }
            if incident.iter().any(|ti| claimed.contains(ti)) {
                continue;
            }
            for &ti in incident {
                let t = tris[ti];
                let a = cpos[t[0]];
                let b = cpos[t[1]];
                let c = cpos[t[2]];
                let asp = aspect(a, b, c);
                if asp <= SLIVER_ASPECT || !tri_in_region(a, b, c) {
                    continue;
                }
                // Scoped mode: finite-aspect slivers only (see MAX_SCOPED_SPLITS).
                if region.is_some() && !asp.is_finite() {
                    continue;
                }
                // Is THIS edge the triangle's LONGEST? Bisecting the longest
                // edge is what reduces the aspect; splitting a short edge of a
                // sliver makes it worse.
                let d = |p: [f64; 3], q: [f64; 3]| {
                    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
                };
                let e01 = d(a, b);
                let e12 = d(b, c);
                let e20 = d(c, a);
                let longest = e01.max(e12).max(e20);
                let this_len = {
                    let (x, y) = *ek;
                    let px = cpos[x];
                    let py = cpos[y];
                    d(px, py)
                };
                if (this_len - longest).abs() < 1.0e-9 {
                    round_edges.push(*ek);
                    claimed.extend(incident.iter().copied());
                    if region.is_none() {
                        break 'outer; // original one-edge-per-round behavior
                    }
                    if splits_done + round_edges.len() >= MAX_SCOPED_SPLITS {
                        break 'outer;
                    }
                    break;
                }
            }
        }

        if round_edges.is_empty() {
            break; // no sliver left
        }

        // New midpoint canonical vertex per split edge, ON the original
        // straight edge ⇒ volume preserved. Snap to the kernel grid for
        // downstream consistency. Ids assigned in `round_edges` (BTreeMap key)
        // order — deterministic.
        let mut edge_mid: BTreeMap<(usize, usize), usize> = BTreeMap::new();
        for &(eu, ev) in &round_edges {
            let a = cpos[eu];
            let b = cpos[ev];
            let pm = [
                snap_grid(0.5 * (a[0] + b[0])),
                snap_grid(0.5 * (a[1] + b[1])),
                snap_grid(0.5 * (a[2] + b[2])),
            ];
            let mid = cpos.len();
            cpos.push(pm);
            edge_mid.insert((eu, ev), mid);
        }

        // Replace each claimed triangle with its two halves about its split
        // edge's midpoint, preserving winding. Each triangle carries at most
        // one split edge (the claim rule above).
        let mut new_tris: Vec<[usize; 3]> = Vec::with_capacity(tris.len() + round_edges.len() * 2);
        for (ti, t) in tris.iter().enumerate() {
            if !claimed.contains(&ti) {
                new_tris.push(*t);
                continue;
            }
            // Rotate so the split edge is (t[k], t[k+1]); the apex is t[k+2].
            let mut split = false;
            for k in 0..3 {
                let u = t[k];
                let v = t[(k + 1) % 3];
                let w = t[(k + 2) % 3];
                if let Some(&mid) = edge_mid.get(&edge_key(u, v)) {
                    // u → mid → w  and  mid → v → w  preserves [u,v,w] winding.
                    new_tris.push([u, mid, w]);
                    new_tris.push([mid, v, w]);
                    split = true;
                    break;
                }
            }
            if !split {
                new_tris.push(*t);
            }
        }
        tris = new_tris;
        changed_any = true;
        splits_done += round_edges.len();
        if region.is_some() && splits_done >= MAX_SCOPED_SPLITS {
            break;
        }
    }

    if !changed_any {
        return mesh.clone();
    }

    // Rebuild a flat mesh from the refined canonical triangles, re-deriving a
    // per-face flat normal (the input may not carry usable normals after a cut).
    let mut positions: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut normals: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut indices: Vec<u32> = Vec::with_capacity(tris.len() * 3);
    for t in &tris {
        let a = cpos[t[0]];
        let b = cpos[t[1]];
        let c = cpos[t[2]];
        let n = tri_normal(a, b, c).map(|(n, _)| n).unwrap_or([0.0, 0.0, 1.0]);
        let base = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            normals.extend_from_slice(&[n[0] as f32, n[1] as f32, n[2] as f32]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    // Carry the host's placement / frame metadata (origin, rtc, #1474 capture)
    // forward. This pass runs AFTER placement, so a bare rebuild would reset the
    // local-frame origin + #1474 capture to defaults and mis-place exactly the
    // hosts whose cuts slivered. `instance_meta` is dropped (the refined mesh no
    // longer matches its canonical rep) — see `Mesh::rebuilt_like`.
    mesh.rebuilt_like(positions, normals, indices)
}
