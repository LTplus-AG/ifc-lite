// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The existing area-weighted plane fit, scoped to one edge-connected patch.

use super::MAX_VERTEX_MOVE;

pub(super) struct Facet {
    pub(super) tri: [usize; 3],
    pub(super) normal: [f64; 3],
    pub(super) offset: f64, // signed-normal plane offset, anchor-local: n·(v0 - anchor)
    pub(super) area2: f64,
}

/// Members retain original facet-index order. The caller supplies the original
/// normal-bucket reference, so a connected cluster keeps its previous fit.
pub(super) fn project_component(
    facets: &[Facet],
    members: &[usize],
    ref_n: [f64; 3],
    canon_pos: &[[f64; 3]],
    anchor: [f64; 3],
    vertex_moves: &mut [Vec<[f64; 3]>],
) {
    if members.len() < 2 {
        return;
    }
    let mut acc_n = [0.0f64, 0.0, 0.0];
    let mut acc_off = 0.0f64;
    let mut wsum = 0.0f64;
    for &fi in members {
        let n = facets[fi].normal;
        let dotv = n[0] * ref_n[0] + n[1] * ref_n[1] + n[2] * ref_n[2];
        let s = if dotv < 0.0 { -1.0 } else { 1.0 };
        let w = facets[fi].area2;
        acc_n[0] += s * n[0] * w;
        acc_n[1] += s * n[1] * w;
        acc_n[2] += s * n[2] * w;
        acc_off += s * facets[fi].offset * w;
        wsum += w;
    }
    if wsum <= 0.0 {
        return;
    }
    let len = (acc_n[0] * acc_n[0] + acc_n[1] * acc_n[1] + acc_n[2] * acc_n[2]).sqrt();
    if len <= 0.0 {
        return;
    }
    // Plane: unit normal `pn`, offset `pd` so pn·x = pd (anchor-local —
    // `acc_off` was accumulated from anchor-local per-facet offsets).
    // `acc_n · x = acc_off` is the accumulated (non-unit) plane
    // equation: Σ wᵢnᵢ · x = Σ wᵢ(nᵢ·vᵢ), true by construction for any
    // x each member facet's own plane passes through. Converting it to
    // unit-normal form means dividing BOTH sides by the SAME scalar —
    // `|acc_n|` (`len`) — not dividing `acc_n` by `len` while dividing
    // `acc_off` by `wsum`: those differ whenever member facets' normals
    // aren't identical (`len ≤ wsum`, Cauchy–Schwarz, equality only at
    // zero spread), which scales the two sides of the SAME equation by
    // different amounts and desyncs `pd` from `pn` (review: PR #2611).
    let pn = [acc_n[0] / len, acc_n[1] / len, acc_n[2] / len];
    let pd = acc_off / len;
    // Project each cluster vertex onto the plane, capped by MAX_VERTEX_MOVE.
    // Same anchor-local frame as the plane: `p` is `v - anchor`, so
    // `dist` multiplies a mesh-extent magnitude, not the raw world
    // position — the anchor is added back once the projection is done.
    let mut seen_v: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for &fi in members {
        for &cv in &facets[fi].tri {
            if !seen_v.insert(cv) {
                continue;
            }
            let original = canon_pos[cv];
            let p = [
                original[0] - anchor[0],
                original[1] - anchor[1],
                original[2] - anchor[2],
            ];
            let dist = p[0] * pn[0] + p[1] * pn[1] + p[2] * pn[2] - pd;
            if dist.abs() > MAX_VERTEX_MOVE {
                continue; // crease / far vertex — over-weld guard
            }
            let proj = [
                p[0] - dist * pn[0] + anchor[0],
                p[1] - dist * pn[1] + anchor[1],
                p[2] - dist * pn[2] + anchor[2],
            ];
            vertex_moves[cv].push(proj);
        }
    }
}
