// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cap and profile-edge extension: push a flush cap or profile edge past
//! the host surface when the swept region is provably empty of host
//! material, with the ray-parity point-in-solid test it relies on.

use super::super::geom::parity::PARITY_RAY_DIR as RAY_DIR;
use super::frame::PrismFrame;
use super::kit::{dot, lerp, V2, V3};
use super::plane2::{pip, seg_cross_param};
use super::profile::ccw_area;
use super::ptri::PTri;

// ─────────────────────────── ray parity (point in solid) ─────────────────────

/// Möller–Trumbore crossing parity of `point` against the triangle list (with
/// precomputed AABBs). Odd ⇒ inside the solid.
pub(super) fn point_inside(tris: &[PTri], aabbs: &[(V3, V3)], point: V3) -> bool {
    let mut crossings = 0usize;
    for (t, (_lo, hi)) in tris.iter().zip(aabbs) {
        // Cheap reject: every component of `RAY_DIR` is positive, so a hit
        // point has all coordinates strictly greater than the origin's — a
        // triangle entirely below the origin on ANY axis cannot be crossed.
        if hi[0] < point[0] || hi[1] < point[1] || hi[2] < point[2] {
            continue;
        }
        let Some(dist) = super::super::geom::parity::ray_triangle_param(
            point, RAY_DIR, t.p[0], t.p[1], t.p[2], 1.0e-12, 1.0e-9,
        ) else {
            continue;
        };
        if dist > 1.0e-9 {
            crossings += 1;
        }
    }
    crossings % 2 == 1
}

// ────────────────────────────── cap extension ───────────────────────────────

/// Push each prism CAP outward past the host surface when the swept slab is
/// PROVABLY empty of host material: no host triangle intersects (profile
/// footprint × slab) AND a probe point inside the slab lies outside the host
/// solid. A flush window cap then becomes a clean transversal crossing, while
/// a genuine blind-recess bottom (host material beyond the cap) keeps its
/// authored plane.
pub(super) fn extend_prism_caps(pf: &mut PrismFrame, tris: &[PTri], aabbs: &[(V3, V3)]) {
    let span = pf.d1() - pf.d0();
    let delta = (span * 0.1).clamp(0.005, 0.5);
    let mag = pf.corner_mag();
    // Flush-exclusion band: a host FACE lying (near-)flush ON the cap plane —
    // the flush window/sleeve case, or a cutter authored a hair SHORT of the
    // surface (the #1112 roof skylights) — is not material BEYOND the plane
    // and must not block the extension; only geometry clearly past the band
    // does. Matches the exact kernel's flush-cap detection band
    // (`extend_opening_mesh_through_host`: `open_span.max(1.0) * 1e-3`), so
    // the analytic path pushes through exactly where the exact path would.
    let band = (span.max(1.0) * 1.0e-3).max(mag * 4.0e-7);
    let pad = 1.0e-6 * (1.0 + mag);
    for hi_side in [false, true] {
        let (slab_lo, slab_hi) = if hi_side {
            (pf.d1() + band, pf.d1() + delta)
        } else {
            (pf.d0() - delta, pf.d0() - band)
        };
        if slab_hi <= slab_lo {
            continue;
        }
        let (k, interior) = if hi_side {
            (pf.profiles.len() - 1, pf.slab_interior[pf.profiles.len() - 1])
        } else {
            (0, pf.slab_interior[0])
        };
        let profile = &pf.profiles[k];
        let occupied = tris
            .iter()
            .any(|t| tri_touches_slab_footprint(t, pf, profile, slab_lo, slab_hi, pad));
        if occupied {
            continue;
        }
        let probe = pf.lift(interior[0], interior[1], (slab_lo + slab_hi) * 0.5);
        if point_inside(tris, aabbs, probe) {
            continue;
        }
        let last = pf.planes.len() - 1;
        if hi_side {
            pf.planes[last] += delta;
        } else {
            pf.planes[0] -= delta;
        }
    }
}

/// Push a profile EDGE outward past the host surface when the swept band
/// beyond it is provably empty of host material — the side-face analog of the
/// cap extension. The canonical case: a DOOR whose bottom profile edge is
/// flush with the wall's bottom face; without extension that strip is
/// coplanar with host skin (parity garbage), with it the threshold band falls
/// cleanly inside the cutter. Corners are re-derived by intersecting the
/// translated edge line with the (unchanged) neighbour edge lines.
/// Point-in-or-on-polygon: inside by ray parity OR within `eps` of any edge.
/// The boundary tolerance matters for the extension containment check: a
/// re-derived corner is COLLINEAR with the authored corner it replaces (both
/// lie on the shared neighbour-edge line), so the authored corner sits exactly
/// on `cand`'s boundary — a strict interior test would wrongly reject it.
pub(super) fn point_in_or_on(p: V2, poly: &[V2], eps: f64) -> bool {
    let n = poly.len();
    let eps2 = eps * eps;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ap = [p[0] - a[0], p[1] - a[1]];
        let len2 = ab[0] * ab[0] + ab[1] * ab[1];
        if len2 < 1.0e-20 {
            if ap[0] * ap[0] + ap[1] * ap[1] < eps2 {
                return true;
            }
            continue;
        }
        let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / len2).clamp(0.0, 1.0);
        let proj = [a[0] + ab[0] * t, a[1] + ab[1] * t];
        let dx = p[0] - proj[0];
        let dy = p[1] - proj[1];
        if dx * dx + dy * dy < eps2 {
            return true;
        }
    }
    pip(p, poly)
}

/// Whether `outer` contains every vertex of `inner` (boundary-inclusive).
pub(super) fn ring_contains_ring(outer: &[V2], inner: &[V2], eps: f64) -> bool {
    inner.iter().all(|&p| point_in_or_on(p, outer, eps))
}

/// Whether a 2D ring is a SIMPLE polygon: no pair of non-adjacent edges
/// crosses. Adjacent edges (sharing a vertex) are exempt. Used to reject a
/// profile-edge extension that folded a non-convex ring back on itself.
pub(super) fn ring_is_simple(ring: &[V2]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        for j in (i + 1)..n {
            // Skip edges adjacent to edge i (they legitimately share a vertex).
            if j == (i + 1) % n || (j + 1) % n == i {
                continue;
            }
            let (c, d) = (ring[j], ring[(j + 1) % n]);
            if seg_cross_param(a, b, c, d).is_some() {
                return false;
            }
        }
    }
    true
}

pub(super) fn extend_profile_edges(pf: &mut PrismFrame, tris: &[PTri], aabbs: &[(V3, V3)]) {
    let mag = pf.corner_mag();
    let band = 2.0e-4_f64.max(mag * 4.0e-7);
    for k in 0..pf.profiles.len() {
        let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
        // Authored ring for this slab: every extension must keep containing it
        // (a moved edge on a non-convex ring can otherwise shrink the profile).
        let authored = pf.profiles[k].clone();
        let mut i = 0usize;
        while i < pf.profiles[k].len() {
            let prof = pf.profiles[k].clone();
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            if len < 1.0e-6 {
                i += 1;
                continue;
            }
            let ed = [e[0] / len, e[1] / len];
            let n2 = [ed[1], -ed[0]]; // outward for a CCW ring
            let delta = (len * 0.1).clamp(0.01, 0.5);
            // Neighbour edge lines must be genuinely transversal to move the
            // corners; skip near-collinear neighbours.
            let ap = prof[(i + n - 1) % n];
            let bn = prof[(i + 2) % n];
            let d_prev = [a[0] - ap[0], a[1] - ap[1]];
            let d_next = [bn[0] - b[0], bn[1] - b[1]];
            let cr_prev = ed[0] * d_prev[1] - ed[1] * d_prev[0];
            let cr_next = ed[0] * d_next[1] - ed[1] * d_next[0];
            let lp = (d_prev[0] * d_prev[0] + d_prev[1] * d_prev[1]).sqrt();
            let ln = (d_next[0] * d_next[0] + d_next[1] * d_next[1]).sqrt();
            if lp < 1.0e-9 || ln < 1.0e-9 || cr_prev.abs() / lp < 0.1 || cr_next.abs() / ln < 0.1
            {
                i += 1;
                continue;
            }
            // Emptiness of the swept band (band..delta beyond the edge, this
            // slab's depth interval), then an outside-host probe.
            let quad = [
                [a[0] + n2[0] * band, a[1] + n2[1] * band],
                [b[0] + n2[0] * band, b[1] + n2[1] * band],
                [b[0] + n2[0] * delta, b[1] + n2[1] * delta],
                [a[0] + n2[0] * delta, a[1] + n2[1] * delta],
            ];
            let pad = 1.0e-6 * (1.0 + mag);
            let occupied = tris
                .iter()
                .any(|t| tri_touches_slab_footprint(t, pf, &quad, w_a, w_b, pad));
            if occupied {
                i += 1;
                continue;
            }
            let mid_off = (band + delta) * 0.5;
            let probe2 = [
                (a[0] + b[0]) * 0.5 + n2[0] * mid_off,
                (a[1] + b[1]) * 0.5 + n2[1] * mid_off,
            ];
            let probe = pf.lift(probe2[0], probe2[1], (w_a + w_b) * 0.5);
            if point_inside(tris, aabbs, probe) {
                i += 1;
                continue;
            }
            // Translate the edge line by delta and re-derive its two corners
            // as intersections with the neighbour edge lines.
            let line_pt = [a[0] + n2[0] * delta, a[1] + n2[1] * delta];
            let isect = |p0: V2, dir0: V2| -> Option<V2> {
                // line_pt + t·ed  ==  p0 + s·dir0
                let den = ed[0] * dir0[1] - ed[1] * dir0[0];
                if den.abs() < 1.0e-12 {
                    return None;
                }
                let dx = [p0[0] - line_pt[0], p0[1] - line_pt[1]];
                let t = (dx[0] * dir0[1] - dx[1] * dir0[0]) / den;
                Some([line_pt[0] + ed[0] * t, line_pt[1] + ed[1] * t])
            };
            let (Some(na), Some(nb)) = (
                isect(ap, [d_prev[0] / lp, d_prev[1] / lp]),
                isect(b, [d_next[0] / ln, d_next[1] / ln]),
            ) else {
                i += 1;
                continue;
            };
            // Commit the extension only if the resulting ring stays SIMPLE and
            // still contains the authored profile. `ccw_area` accepts a
            // self-intersecting ring (positive signed area), so the downstream
            // volume self-check cannot catch an over/under-cut from a folded
            // non-convex ring — validate here and keep the un-extended edge
            // otherwise.
            let mut cand = pf.profiles[k].clone();
            cand[i] = na;
            cand[(i + 1) % n] = nb;
            // Boundary-tolerant containment: the authored corners are collinear
            // with (and on the boundary of) `cand`, so a strict interior test
            // is unusable — `contain_eps` (≫ the collinearity float error, ≪
            // any real shrink) accepts a genuine outward growth and rejects a
            // reflex corner that pulled the profile inward.
            let contain_eps = 1.0e-6 * (1.0 + mag);
            if ring_is_simple(&cand) && ring_contains_ring(&cand, &authored, contain_eps) {
                pf.profiles[k] = cand;
            }
            i += 1;
        }
        // Refresh the slab area (the interior point stays valid — the profile
        // only grew).
        let mut ring = pf.profiles[k].clone();
        if let Some(area) = ccw_area(&mut ring) {
            pf.profiles[k] = ring;
            pf.slab_area[k] = area;
        }
    }
    // Refresh the overall bbox.
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for prof in &pf.profiles {
        for p in prof {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    pf.bb = (lo, hi);
}

/// Whether triangle `t` has a non-degenerate piece inside the region
/// `{depth ∈ [slab_lo, slab_hi]} ∩ {(u,v) within the (pad-inflated) profile}`.
/// Conservative in the safe direction: any doubt reports "occupied" (⇒ no cap
/// extension ⇒ at worst a later self-check fallback, never an over-cut).
pub(super) fn tri_touches_slab_footprint(
    t: &PTri,
    pf: &PrismFrame,
    profile: &[V2],
    slab_lo: f64,
    slab_hi: f64,
    pad: f64,
) -> bool {
    // Clip the triangle to the depth slab (two parallel planes) — convex S-H.
    let mut poly: Vec<V3> = t.p.to_vec();
    for hi_side in [false, true] {
        if poly.len() < 3 {
            return false;
        }
        let mut next: Vec<V3> = Vec::with_capacity(poly.len() + 1);
        let dist = |p: V3| -> f64 {
            let w = dot(p, pf.d);
            if hi_side {
                w - slab_hi
            } else {
                slab_lo - w
            }
        };
        for i in 0..poly.len() {
            let j = (i + 1) % poly.len();
            let (da, db) = (dist(poly[i]), dist(poly[j]));
            if da <= 0.0 {
                next.push(poly[i]);
            }
            if (da <= 0.0) != (db <= 0.0) {
                next.push(lerp(poly[i], poly[j], da / (da - db)));
            }
        }
        poly = next;
    }
    if poly.len() < 3 {
        return false;
    }
    // 2D overlap of the clipped (convex) polygon with the profile: vertex of
    // one inside the other, or any edge pair crossing.
    let poly2: Vec<V2> = poly.iter().map(|p| pf.to2(*p)).collect();
    // bbox prefilter with pad — against the SUPPLIED `profile` footprint, NOT
    // `pf.bb`. The profile-edge extension passes an outward band that can lie
    // entirely OUTSIDE the prism's overall bbox; prefiltering on pf.bb would
    // wrongly report "empty" and let the extension sweep through nearby host
    // material.
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in &poly2 {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let mut footprint_lo = [f64::INFINITY; 2];
    let mut footprint_hi = [f64::NEG_INFINITY; 2];
    for p in profile {
        for k in 0..2 {
            footprint_lo[k] = footprint_lo[k].min(p[k]);
            footprint_hi[k] = footprint_hi[k].max(p[k]);
        }
    }
    if hi[0] < footprint_lo[0] - pad
        || lo[0] > footprint_hi[0] + pad
        || hi[1] < footprint_lo[1] - pad
        || lo[1] > footprint_hi[1] + pad
    {
        return false;
    }
    if poly2.iter().any(|p| pip(*p, profile)) {
        return true;
    }
    if profile.iter().any(|p| pip(*p, &poly2)) {
        return true;
    }
    let np = poly2.len();
    let nq = profile.len();
    for i in 0..np {
        let (a, b) = (poly2[i], poly2[(i + 1) % np]);
        for j in 0..nq {
            let (c, d2) = (profile[j], profile[(j + 1) % nq]);
            if seg_cross_param(a, b, c, d2).is_some() {
                return true;
            }
        }
    }
    false
}
