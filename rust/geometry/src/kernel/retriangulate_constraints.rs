// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


//! Existing constraint-chain decomposition; reports any nontrivial recovery attempt.
use crate::kernel::interner::{Interner, Vid};
use crate::kernel::retriangulate::{cmp_lex_v, coord2d_cached, edge_exists, lex_cmp, orient2d_v, Mesh2d, PREFILTER_MIN};
use crate::kernel::Sign;
use super::{between, recover_subsegment, recover_via_traversal};
use std::collections::BTreeSet;

pub(crate) fn enforce_constraint(mesh: &mut Mesh2d, it: &Interner, s: Vid, t: Vid) -> bool {
    let axis = mesh.axis;
    let verts: BTreeSet<Vid> = mesh.tris.iter().flatten().copied().collect();
    // Broadphase: a vertex collinear with AND between s,t must lie in the
    // segment's 2D f64 AABB. Skip the (i1024, WASM-emulated) exact orient2d for
    // vertices outside the widened box. Same conservative margin as the
    // insert_point prefilter ⇒ a real on-segment vertex is never skipped on any
    // platform, so `on_seg` — and the recovered topology — is byte-identical.
    // This is the hot loop: enforce runs per constraint per fixed-point pass, so
    // the unfiltered O(verts) exact scan is what stalls many-opening facades.
    // Engaged only once the vertex set is large enough to amortise the cache.
    let seg_box: Option<[f64; 4]> = if verts.len() > PREFILTER_MIN {
        match (
            coord2d_cached(it, s, axis, &mut mesh.coords),
            coord2d_cached(it, t, axis, &mut mesh.coords),
        ) {
            (Some(s2), Some(t2)) => Some([
                s2[0].min(t2[0]),
                s2[1].min(t2[1]),
                s2[0].max(t2[0]),
                s2[1].max(t2[1]),
            ]),
            _ => None,
        }
    } else {
        None
    };
    let mut on_seg: Vec<Vid> = verts
        .into_iter()
        .filter(|&v| {
            if v == s || v == t {
                return false;
            }
            if let Some(bx) = seg_box {
                if let Some(vc) = coord2d_cached(it, v, axis, &mut mesh.coords) {
                    let mx = 1e-6 + vc[0].abs() * 1e-9;
                    let my = 1e-6 + vc[1].abs() * 1e-9;
                    if vc[0] < bx[0] - mx
                        || vc[0] > bx[2] + mx
                        || vc[1] < bx[1] - my
                        || vc[1] > bx[3] + my
                    {
                        return false; // outside segment AABB ⇒ cannot lie on it
                    }
                }
            }
            orient2d_v(it, s, t, v, axis) == Sign::Zero && between(it, s, t, v)
        })
        .collect();
    on_seg.sort_by(|&x, &y| lex_cmp(it, x, y));
    if cmp_lex_v(it, s, t) == Sign::Positive {
        on_seg.reverse(); // order from s toward t
    }
    let mut chain = vec![s];
    chain.extend(on_seg);
    chain.push(t);
    let mut attempted = false;
    for w in chain.windows(2) {
        attempted |= recover_subsegment(mesh, it, w[0], w[1]);
        // Robust fallback for the dense-face constraints the boundary-walk pocket
        // split can't force (issue #098 V5C). Only runs on that failure, so the
        // common path stays byte-identical.
        if !edge_exists(mesh, w[0], w[1]) {
            recover_via_traversal(mesh, it, w[0], w[1]);
        }
    }
    attempted
}
