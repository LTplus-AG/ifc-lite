// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The prism cut: subtract a stepped solid from the host triangle list, or
//! return the defer reason that sends the opening to the exact kernel.

use super::caps::{build_face_cap, cap_plane_breakpoints};
use super::checks::{has_measurable_region, partition_consistent};
use super::decompose::decompose_tri;
use super::face::{cached_crossing, face_plane, CrossCache, Seam};
use super::frame::{cap_xor, stack_faces, Face, PrismFrame};
use super::kit::{add, dot, lerp, scale, V2, V3};
use super::plane2::seg_cross_param;
use super::ptri::PTri;

/// Subtract the stepped solid `pf` from the host triangle list. `Err(defer
/// index)` ⇒ a gate or self-check failed ⇒ the caller must leave the host
/// untouched and route this opening to the exact kernel.
pub(super) fn cut_prism(tris: &[PTri], pf: &PrismFrame) -> Result<Vec<PTri>, usize> {
    let faces = stack_faces(pf);
    if faces.len() > u16::MAX as usize {
        return Err(7);
    }
    let mut planes: Vec<(V3, f64)> = Vec::with_capacity(faces.len());
    for &face in &faces {
        planes.push(face_plane(pf, face).ok_or(7usize)?);
    }

    let aabbs: Vec<(V3, V3)> = tris.iter().map(PTri::aabb).collect();
    let mut cache: CrossCache = CrossCache::default();

    let mut out: Vec<PTri> = Vec::with_capacity(tris.len() + 16);
    let mut inside: Vec<PTri> = Vec::new();
    let mut seams: Vec<Vec<Seam>> = (0..faces.len()).map(|_| Vec::new()).collect();
    let mut any_cut = false;

    for t in tris {
        // Quick reject: depth interval and 2D bbox versus the overall bbox.
        let w0 = dot(t.p[0], pf.d);
        let w1 = dot(t.p[1], pf.d);
        let w2 = dot(t.p[2], pf.d);
        if w0.max(w1).max(w2) < pf.d0() || w0.min(w1).min(w2) > pf.d1() {
            out.push(t.clone());
            continue;
        }
        {
            let q0 = pf.to2(t.p[0]);
            let q1 = pf.to2(t.p[1]);
            let q2 = pf.to2(t.p[2]);
            let lo = [q0[0].min(q1[0]).min(q2[0]), q0[1].min(q1[1]).min(q2[1])];
            let hi = [q0[0].max(q1[0]).max(q2[0]), q0[1].max(q1[1]).max(q2[1])];
            if hi[0] < pf.bb.0[0]
                || lo[0] > pf.bb.1[0]
                || hi[1] < pf.bb.0[1]
                || lo[1] > pf.bb.1[1]
            {
                out.push(t.clone());
                continue;
            }
        }

        // Gather T ∩ ∂solid seam sub-segments + T-edge subdivision points.
        let mut segs: Vec<(usize, V3, V3)> = Vec::new(); // (face idx, a3, b3)
        let mut edge_pts: [Vec<V3>; 3] = Default::default();
        for (fi, (&face, &(m, c))) in faces.iter().zip(&planes).enumerate() {
            // Chord of T with this face plane (strict >0 side test — symmetric
            // and vertex-exact, so neighbours agree bit-for-bit).
            let dist = [
                dot(t.p[0], m) - c,
                dot(t.p[1], m) - c,
                dot(t.p[2], m) - c,
            ];
            let mut chord: Vec<(V3, usize)> = Vec::new(); // (point, tri edge)
            for e in 0..3 {
                let (da, db) = (dist[e], dist[(e + 1) % 3]);
                if (da > 0.0) != (db > 0.0) {
                    let p = cached_crossing(
                        &mut cache,
                        fi as u16,
                        m,
                        c,
                        t.p[e],
                        t.p[(e + 1) % 3],
                    );
                    chord.push((p, e));
                }
            }
            if chord.len() != 2 {
                continue;
            }
            let (q0, e0) = chord[0];
            let (q1, e1) = chord[1];
            // Face-local membership gate + clipping of the chord to the face's
            // exposed region.
            match face {
                Face::Cap { j } => {
                    let a2 = pf.to2(q0);
                    let b2 = pf.to2(q1);
                    // T-edge subdivision membership (point-deterministic —
                    // both neighbours agree).
                    if cap_xor(pf, j, a2) {
                        edge_pts[e0].push(q0);
                    }
                    if cap_xor(pf, j, b2) {
                        edge_pts[e1].push(q1);
                    }
                    // Subdivide the 2D chord at crossings with BOTH adjacent
                    // profiles' edges; keep sub-segments inside the XOR region.
                    let mut ts: Vec<f64> = vec![0.0, 1.0];
                    for prof in [
                        (j > 0).then(|| &pf.profiles[j - 1]),
                        (j < pf.profiles.len()).then(|| &pf.profiles[j]),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        let npr = prof.len();
                        for i in 0..npr {
                            let (pa, pb) = (prof[i], prof[(i + 1) % npr]);
                            if let Some(tt) = seg_cross_param(a2, b2, pa, pb) {
                                ts.push(tt);
                            }
                        }
                    }
                    ts.sort_by(f64::total_cmp);
                    ts.dedup_by(|x, y| (*x - *y).abs() < 1.0e-12);
                    for wnd in ts.windows(2) {
                        let (ta, tb) = (wnd[0], wnd[1]);
                        if tb - ta < 1.0e-12 {
                            continue;
                        }
                        let mid = [
                            a2[0] + (b2[0] - a2[0]) * (ta + tb) * 0.5,
                            a2[1] + (b2[1] - a2[1]) * (ta + tb) * 0.5,
                        ];
                        if cap_xor(pf, j, mid) {
                            let sa = if ta == 0.0 { q0 } else { lerp(q0, q1, ta) };
                            let sb = if tb == 1.0 { q1 } else { lerp(q0, q1, tb) };
                            segs.push((fi, sa, sb));
                        }
                    }
                }
                Face::Strip { k, i } => {
                    let prof = &pf.profiles[k];
                    let npr = prof.len();
                    let a = prof[i];
                    let b = prof[(i + 1) % npr];
                    let e2 = [b[0] - a[0], b[1] - a[1]];
                    let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
                    let ed = [e2[0] / len, e2[1] / len];
                    let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
                    let sparam = |p: V3| -> f64 {
                        let q = pf.to2(p);
                        (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1]
                    };
                    let wparam = |p: V3| dot(p, pf.d);
                    let (s0, s1) = (sparam(q0), sparam(q1));
                    let (wc0, wc1) = (wparam(q0), wparam(q1));
                    // Membership gate for T-edge subdivision.
                    let in_strip =
                        |s: f64, w: f64| (0.0..=len).contains(&s) && (w_a..=w_b).contains(&w);
                    if in_strip(s0, wc0) {
                        edge_pts[e0].push(q0);
                    }
                    if in_strip(s1, wc1) {
                        edge_pts[e1].push(q1);
                    }
                    // τ interval on the chord where both params are in range.
                    let mut t_lo = 0.0f64;
                    let mut t_hi = 1.0f64;
                    for (p0, p1, lo, hi) in [(s0, s1, 0.0, len), (wc0, wc1, w_a, w_b)] {
                        let dp = p1 - p0;
                        if dp.abs() < 1.0e-15 {
                            if p0 < lo || p0 > hi {
                                t_lo = 1.0;
                                t_hi = 0.0;
                            }
                        } else {
                            let (mut ta, mut tb) = ((lo - p0) / dp, (hi - p0) / dp);
                            if ta > tb {
                                std::mem::swap(&mut ta, &mut tb);
                            }
                            t_lo = t_lo.max(ta);
                            t_hi = t_hi.min(tb);
                        }
                    }
                    if t_hi - t_lo > 1.0e-12 {
                        let sa = if t_lo == 0.0 { q0 } else { lerp(q0, q1, t_lo) };
                        let sb = if t_hi == 1.0 { q1 } else { lerp(q0, q1, t_hi) };
                        segs.push((fi, sa, sb));
                    }
                }
            }
        }

        if segs.is_empty() && edge_pts.iter().all(|v| v.is_empty()) {
            // No boundary reaches this triangle: it is wholly inside or wholly
            // outside the (open) solid.
            let centroid = scale(add(add(t.p[0], t.p[1]), t.p[2]), 1.0 / 3.0);
            if pf.contains(centroid) {
                inside.push(t.clone());
                any_cut = true;
            } else {
                out.push(t.clone());
            }
            continue;
        }

        // Conforming decomposition of T by the seam constraints.
        if !decompose_tri(t, pf, &faces, &segs, &edge_pts, &mut out, &mut inside, &mut seams) {
            return Err(7);
        }
        any_cut = true;
    }

    if !any_cut {
        return Err(4); // nothing to remove — a silent no-op belongs to the exact path
    }

    // Canonical per-cap-plane breakpoints: the vertices of both adjacent
    // profiles plus every proper crossing between their ring edges. Injected
    // into the cap AND every strip bordering that plane, so the faces sharing
    // a cutter-edge line subdivide it IDENTICALLY (T-junction freedom across
    // faces — the cap knows about profile corners the strip alone does not).
    let plane_pts: Vec<Vec<V2>> = (0..pf.planes.len())
        .map(|j| cap_plane_breakpoints(pf, j))
        .collect();

    // Caps: one CDT per face, constrained by that face's seams, classified by
    // ray parity against the PRE-CUT host.
    let mut caps: Vec<PTri> = Vec::new();
    for (fi, &face) in faces.iter().enumerate() {
        if !build_face_cap(pf, face, &seams[fi], &plane_pts, tris, &aabbs, &mut caps) {
            return Err(7);
        }
    }

    if !partition_consistent(tris, &out, &inside, &aabbs) {
        return Err(8);
    }
    if !has_measurable_region(&inside, &caps) {
        return Err(4);
    }

    // The inside fragments and caps are not independently closed surfaces.
    // Their divergence sums cannot measure removal (#4627). The extended
    // cutter volumes instead bound the final audited result in the driver.
    // The driver consolidates and audits the actual result before committing.
    out.append(&mut caps);
    Ok(out)
}
