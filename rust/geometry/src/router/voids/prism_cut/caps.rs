// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reveal caps: the canonical breakpoints of a cap plane and the cap built
//! for each cutter face from its seams, kept where it lies in the exposed
//! region and inside the pre-cut host.

use super::cap_cdt::{cap_cdt, cap_cdt_xor, emit_cap};
use super::extension::point_inside;
use super::face::Seam;
use super::frame::{Face, PrismFrame};
use super::kit::{add, scale, V2, V3};
use super::plane2::{pip, seg_cross_param};
use super::ptri::PTri;

/// Canonical 2D breakpoints of cap plane `j`: all vertices of the adjacent
/// slab profiles plus every proper pairwise crossing between the two rings.
pub(super) fn cap_plane_breakpoints(pf: &PrismFrame, j: usize) -> Vec<V2> {
    let mut profs: Vec<&[V2]> = Vec::new();
    if j > 0 {
        profs.push(&pf.profiles[j - 1]);
    }
    if j < pf.profiles.len() {
        profs.push(&pf.profiles[j]);
    }
    let mut out: Vec<V2> = Vec::new();
    for prof in &profs {
        out.extend_from_slice(prof);
    }
    if profs.len() == 2 {
        let (a, b) = (profs[0], profs[1]);
        let (na, nb) = (a.len(), b.len());
        for i in 0..na {
            let (p, q) = (a[i], a[(i + 1) % na]);
            for k in 0..nb {
                let (c, d) = (b[k], b[(k + 1) % nb]);
                if let Some(t) = seg_cross_param(p, q, c, d) {
                    if (1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
                    }
                }
            }
        }
    }
    out
}

/// Build the cap (reveal face) for one cutter face: CDT of the face domain
/// constrained by the reveal seams (and, for a stepped cap, the adjacent
/// profiles' rings), each sub-triangle kept iff its centroid lies in the
/// face's exposed region AND inside the (pre-cut) host solid by ray parity.
/// Emitted oriented for the RESULT (normal pointing INTO the removed void).
/// Returns false on CDT failure.
pub(super) fn build_face_cap(
    pf: &PrismFrame,
    face: Face,
    seams: &[Seam],
    plane_pts: &[Vec<V2>],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    match face {
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let npr = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % npr];
            let e2 = [b[0] - a[0], b[1] - a[1]];
            let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
            if len < 1.0e-9 {
                return true;
            }
            let ed = [e2[0] / len, e2[1] / len];
            let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
            let lift_s =
                |s: f64, wd: f64| -> V3 { pf.lift(a[0] + ed[0] * s, a[1] + ed[1] * s, wd) };
            let ring2: Vec<V2> = vec![[0.0, w_a], [len, w_a], [len, w_b], [0.0, w_b]];
            let ring3: Vec<V3> = vec![
                lift_s(0.0, w_a),
                lift_s(len, w_a),
                lift_s(len, w_b),
                lift_s(0.0, w_b),
            ];
            // Outward 2D normal of the CCW ring edge; the result-cap normal is
            // its opposite (into the void). CCW-in-(s, w) lifts to the OUTWARD
            // strip normal ⇒ always flip.
            let n2 = [e2[1] / len, -e2[0] / len];
            let outward = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let desired = scale(outward, -1.0);
            // Inject the canonical breakpoints of BOTH bounding cap planes
            // that lie on this strip's edge line, so the strip subdivides its
            // shared boundary exactly like the neighbouring caps do.
            let mut inject: Vec<(V2, V3)> = Vec::new();
            let on_line_tol = 1.0e-6 * (1.0 + pf.corner_mag());
            for (jj, wj) in [(k, w_a), (k + 1, w_b)] {
                for q in &plane_pts[jj] {
                    let ap = [q[0] - a[0], q[1] - a[1]];
                    let ss = ap[0] * ed[0] + ap[1] * ed[1];
                    if !(0.0..=len).contains(&ss) {
                        continue;
                    }
                    let perp = (ap[0] * ed[1] - ap[1] * ed[0]).abs();
                    if perp <= on_line_tol {
                        inject.push(([ss, wj], lift_s(ss, wj)));
                    }
                }
            }
            if seams.is_empty() && inject.is_empty() {
                // Entirely inside the host (whole-face reveal) or entirely
                // outside — one parity probe decides.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
                emit_cap(caps, ring3[0], ring3[1], ring3[2], desired, true);
                emit_cap(caps, ring3[0], ring3[2], ring3[3], desired, true);
                return true;
            }
            if seams.is_empty() {
                // Injected points but no seams: same parity probe decides
                // whole-face vs nothing, but the emission must still be the
                // subdivided CDT so the shared boundary matches the caps.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
            }
            cap_cdt(
                pf,
                &ring2,
                &ring3,
                &[],
                seams,
                &inject,
                desired,
                true,
                |q| pip(q, &ring2),
                host,
                aabbs,
                caps,
            )
        }
        Face::Cap { j } => {
            let wdepth = pf.planes[j];
            // Domain ring: the union bbox of the adjacent profiles, slightly
            // inflated so profile rings are strictly interior constraints.
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            let mut aux: Vec<&[V2]> = Vec::new();
            if j > 0 {
                aux.push(&pf.profiles[j - 1]);
            }
            if j < pf.profiles.len() {
                aux.push(&pf.profiles[j]);
            }
            for prof in &aux {
                for p in prof.iter() {
                    for k in 0..2 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
            let m = 1.0e-3 * (1.0 + (hi[0] - lo[0]).abs().max((hi[1] - lo[1]).abs()));
            let (lo, hi) = ([lo[0] - m, lo[1] - m], [hi[0] + m, hi[1] + m]);
            let ring2: Vec<V2> = vec![
                [lo[0], lo[1]],
                [hi[0], lo[1]],
                [hi[0], hi[1]],
                [lo[0], hi[1]],
            ];
            let ring3: Vec<V3> = ring2
                .iter()
                .map(|&[uu, vv]| pf.lift(uu, vv, wdepth))
                .collect();
            // Orientation per sub-region: where only the LOWER slab exists the
            // removed void is below ⇒ normal −d; where only the UPPER slab
            // exists ⇒ +d. Resolved per emitted triangle inside `cap_cdt` via
            // the classifier below; the `desired`/flip passed in cover the
            // "+d" branch and the emitter flips for the −d case.
            let in_lower = |q: V2| j > 0 && pip(q, &pf.profiles[j - 1]);
            let in_upper = |q: V2| j < pf.profiles.len() && pip(q, &pf.profiles[j]);
            // Fast skip for the OUTERMOST caps with no seams (the common
            // extended-cap case): probe the adjacent slab interior.
            if seams.is_empty() && (j == 0 || j == pf.profiles.len()) {
                let k = if j == 0 { 0 } else { pf.profiles.len() - 1 };
                let interior = pf.slab_interior[k];
                let probe = pf.lift(interior[0], interior[1], wdepth);
                if !point_inside(host, aabbs, probe) {
                    return true;
                }
            }
            let inject: Vec<(V2, V3)> = plane_pts[j]
                .iter()
                .map(|&q| (q, pf.lift(q[0], q[1], wdepth)))
                .collect();
            cap_cdt_xor(
                pf,
                &ring2,
                &ring3,
                &aux,
                seams,
                &inject,
                wdepth,
                in_lower,
                in_upper,
                host,
                aabbs,
                caps,
            )
        }
    }
}
