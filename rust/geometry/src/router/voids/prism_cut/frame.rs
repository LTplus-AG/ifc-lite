// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The stepped-extrusion cutter (`PrismFrame`), its faces, and the OBB
//! overlap veto.

use super::kit::{add, cross, dot, norm, normalize, scale, sub, V2, V3};
use super::plane2::pip;

// ─────────────────────────────── prism cutter ───────────────────────────────

/// Maximum profile vertex count admitted to the analytic path (face ids must
/// fit `u8`, and a pathological many-gon belongs to the exact kernel anyway).
pub(super) const MAX_PROFILE_VERTS: usize = 120;

/// A stepped-extrusion cutter: a stack of K depth slabs along axis `d`, slab
/// `k` spanning `planes[k]..planes[k+1]` with constant CCW cross-section
/// `profiles[k]`. K = 1 is a plain prism; K > 1 is the REBATED masonry opening
/// (the ISSUE_098 window voids: outer box + inner box sharing a step plane).
/// `(u, v, d)` is orthonormal right-handed (`u × v = d`).
#[derive(Clone)]
pub(super) struct PrismFrame {
    pub(super) u: V3,
    pub(super) v: V3,
    pub(super) d: V3,
    /// K+1 sorted depth planes.
    pub(super) planes: Vec<f64>,
    /// K CCW simple polygons (no holes), one per slab.
    pub(super) profiles: Vec<Vec<V2>>,
    /// Per-slab |area|.
    pub(super) slab_area: Vec<f64>,
    /// Per-slab strictly interior point (max-area CDT triangle centroid —
    /// robust for non-convex rebated profiles).
    pub(super) slab_interior: Vec<V2>,
    /// Overall profile bounding box (lo, hi) in `(u, v)`.
    pub(super) bb: (V2, V2),
}

impl PrismFrame {
    #[inline]
    pub(super) fn d0(&self) -> f64 {
        self.planes[0]
    }
    #[inline]
    pub(super) fn d1(&self) -> f64 {
        *self.planes.last().unwrap()
    }
    #[inline]
    pub(super) fn volume(&self) -> f64 {
        (0..self.profiles.len())
            .map(|k| self.slab_area[k] * (self.planes[k + 1] - self.planes[k]))
            .sum()
    }
    /// Canonical lift `(u, v, depth) → 3D`. FIXED summation order so every
    /// face computing the same point produces identical bits.
    #[inline]
    pub(super) fn lift(&self, uu: f64, vv: f64, w: f64) -> V3 {
        add(add(scale(self.u, uu), scale(self.v, vv)), scale(self.d, w))
    }
    #[inline]
    pub(super) fn to2(&self, p: V3) -> V2 {
        [dot(p, self.u), dot(p, self.v)]
    }
    /// Strict interior test (open solid).
    #[inline]
    pub(super) fn contains(&self, p: V3) -> bool {
        let w = dot(p, self.d);
        if w <= self.d0() || w >= self.d1() {
            return false;
        }
        let q = self.to2(p);
        for k in 0..self.profiles.len() {
            if w < self.planes[k + 1] {
                return pip(q, &self.profiles[k]);
            }
        }
        false
    }
    /// Largest coordinate magnitude over the swept profile corners (epsilon
    /// scaling).
    pub(super) fn corner_mag(&self) -> f64 {
        let mut mag = 0.0f64;
        for prof in &self.profiles {
            for &[uu, vv] in prof {
                for w in [self.d0(), self.d1()] {
                    for c in self.lift(uu, vv, w) {
                        mag = mag.max(c.abs());
                    }
                }
            }
        }
        mag
    }
    /// Conservative OBB of the solid (profile bbox × depth) as (axes, lo, hi)
    /// intervals for the SAT overlap veto.
    pub(super) fn obb(&self) -> ([V3; 3], V3, V3) {
        (
            [self.u, self.v, self.d],
            [self.bb.0[0], self.bb.0[1], self.d0()],
            [self.bb.1[0], self.bb.1[1], self.d1()],
        )
    }
}

/// One face of the stepped solid.
#[derive(Clone, Copy)]
pub(super) enum Face {
    /// The depth plane `planes[j]`; its exposed region is the XOR of the
    /// adjacent slab profiles (`∅` beyond the ends).
    Cap { j: usize },
    /// Side strip of slab `k`, profile edge `i`, over
    /// `planes[k]..planes[k+1]`.
    Strip { k: usize, i: usize },
}

/// Enumerate the faces of a stack deterministically.
pub(super) fn stack_faces(pf: &PrismFrame) -> Vec<Face> {
    let mut out = Vec::new();
    for j in 0..pf.planes.len() {
        out.push(Face::Cap { j });
    }
    for k in 0..pf.profiles.len() {
        for i in 0..pf.profiles[k].len() {
            out.push(Face::Strip { k, i });
        }
    }
    out
}

/// Whether a 2D point lies in cap `j`'s exposed region: inside exactly one of
/// the two adjacent slab profiles (XOR; the region a stepped shoulder or an
/// end cap exposes). Point-deterministic — every caller agrees.
pub(super) fn cap_xor(pf: &PrismFrame, j: usize, q: V2) -> bool {
    let in_prev = j > 0 && pip(q, &pf.profiles[j - 1]);
    let in_next = j < pf.profiles.len() && pip(q, &pf.profiles[j]);
    in_prev != in_next
}

/// Oriented-box overlap via the separating-axis theorem (15 axes), with a
/// positive `margin` treating near-contact as overlap. Boxes given as
/// (orthonormal axes, per-axis projection interval).
pub(super) fn obb_overlaps(a: &([V3; 3], V3, V3), b: &([V3; 3], V3, V3), margin: f64) -> bool {
    let centre = |x: &([V3; 3], V3, V3)| -> V3 {
        let mid = [
            (x.1[0] + x.2[0]) * 0.5,
            (x.1[1] + x.2[1]) * 0.5,
            (x.1[2] + x.2[2]) * 0.5,
        ];
        add(
            add(scale(x.0[0], mid[0]), scale(x.0[1], mid[1])),
            scale(x.0[2], mid[2]),
        )
    };
    let half = |x: &([V3; 3], V3, V3), k: usize| (x.2[k] - x.1[k]) * 0.5;
    let dvec = sub(centre(b), centre(a));
    let mut axes: Vec<V3> = Vec::with_capacity(15);
    for k in 0..3 {
        axes.push(a.0[k]);
        axes.push(b.0[k]);
    }
    for i in 0..3 {
        for j in 0..3 {
            let c = cross(a.0[i], b.0[j]);
            if norm(c) > 1.0e-9 {
                axes.push(c);
            }
        }
    }
    for l in axes {
        let Some(l) = normalize(l) else { continue };
        let ra: f64 = (0..3).map(|k| half(a, k) * dot(a.0[k], l).abs()).sum();
        let rb: f64 = (0..3).map(|k| half(b, k) * dot(b.0[k], l).abs()).sum();
        if dot(dvec, l).abs() > ra + rb + margin {
            return false;
        }
    }
    true
}
