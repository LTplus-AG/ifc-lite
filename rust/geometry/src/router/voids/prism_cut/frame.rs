// SPDX-License-Identifier: MPL-2.0
use super::*;

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

/// Detect that the (welded) cutter is a stepped extrusion and extract its
/// stack. `verts`/`tris` are the welded cutter in host-local coordinates;
/// `mesh_vol` is the enclosed volume of the (unwelded) cutter. Conservative:
/// any doubt returns `None` → the exact kernel keeps the opening.
pub(super) fn detect_prism(verts: &[V3], tris: &[[usize; 3]], mesh_vol: f64) -> Option<PrismFrame> {
    if tris.len() < 8 || tris.len() > 4096 {
        return None;
    }
    // Facet normals; cluster into candidate depth directions.
    let mut normals: Vec<Option<V3>> = Vec::with_capacity(tris.len());
    for t in tris {
        let (a, b, c) = (verts[t[0]], verts[t[1]], verts[t[2]]);
        normals.push(normalize(cross(sub(b, a), sub(c, a))));
    }
    let clusters = depth_axes::cluster(&normals)?;
    let mut mag = 0.0f64;
    for v in verts {
        for c in v {
            mag = mag.max(c.abs());
        }
    }
    let plane_tol = 1.0e-4_f64.max(mag * 1.0e-6);
    // Try each cluster direction as the depth axis: every facet must be
    // parallel (a cap/step, on one of a few depth planes) or perpendicular
    // (a side) to it.
    'cand: for dc in &clusters {
        let d = *dc;
        let mut wlo = f64::INFINITY;
        let mut whi = f64::NEG_INFINITY;
        for v in verts {
            let w = dot(*v, d);
            wlo = wlo.min(w);
            whi = whi.max(w);
        }
        if whi - wlo < 1.0e-4 {
            continue;
        }
        // Collect the depth planes carried by parallel facets.
        let mut plane_ws: Vec<f64> = vec![wlo, whi];
        for (t, n) in tris.iter().zip(&normals) {
            let Some(n) = n else { continue };
            let a = dot(*n, d).abs();
            if a > 0.9999 {
                let w = dot(verts[t[0]], d);
                // The whole facet must be planar in depth.
                if t
                    .iter()
                    .any(|&i| (dot(verts[i], d) - w).abs() > plane_tol)
                {
                    continue 'cand;
                }
                if !plane_ws.iter().any(|p| (p - w).abs() <= plane_tol) {
                    plane_ws.push(w);
                }
            } else if a > 0.002 {
                // Neither exactly parallel nor exactly perpendicular ⇒ the
                // cross-section varies along the depth ⇒ not a stepped
                // extrusion about this axis. The tight band matters: a ~1°
                // slanted side would make the mid-slab section drift ~0.5 mm
                // across the slab, poisoning the analytic cut at the weld
                // grid.
                continue 'cand;
            }
        }
        plane_ws.sort_by(f64::total_cmp);
        if plane_ws.len() > MAX_SLABS + 1 {
            continue;
        }
        let (u, v) = basis_from_depth(d)?;
        // One cross-section ring per slab, sliced at the slab midpoint.
        let n_slabs = plane_ws.len() - 1;
        let mut raw_rings: Vec<Vec<V2>> = Vec::with_capacity(n_slabs);
        for k in 0..n_slabs {
            let (w_a, w_b) = (plane_ws[k], plane_ws[k + 1]);
            if w_b - w_a < plane_tol * 2.0 {
                continue 'cand; // sliver slab — numerically fragile, defer
            }
            let w_mid = (w_a + w_b) * 0.5;
            let Some(ring) = cross_section_ring(verts, tris, d, u, v, w_mid) else {
                continue 'cand;
            };
            if ring.len() > MAX_PROFILE_VERTS {
                continue 'cand;
            }
            raw_rings.push(ring);
        }
        if raw_rings.is_empty() {
            continue;
        }
        // SNAP profile coordinates across slabs: the per-slab cross-sections
        // carry independent f32 storage jitter, so a jamb side SHARED by two
        // slabs (no rebate step there) comes back as two near-coincident but
        // unequal edges — µm-wide XOR slivers that wreck the cap CDT and the
        // classification. Cluster all u values (and all v values) across the
        // rings within the f32-jitter bound and remap every ring onto the
        // canonical (first-seen) cluster value. Distinct REAL features (≥ mm)
        // stay distinct; only jitter twins collapse.
        let snap_tol = 3.0e-5_f64.max(mag * 6.0e-7);
        for axis in 0..2 {
            let mut vals: Vec<f64> = raw_rings
                .iter()
                .flat_map(|r| r.iter().map(|p| p[axis]))
                .collect();
            vals.sort_by(f64::total_cmp);
            let mut canon: Vec<f64> = Vec::new();
            for x in vals {
                match canon.last() {
                    Some(&last) if (x - last).abs() <= snap_tol => {}
                    _ => canon.push(x),
                }
            }
            for ring in raw_rings.iter_mut() {
                for pnt in ring.iter_mut() {
                    // Nearest canonical value (canon sorted; linear scan is
                    // fine at these sizes, deterministic).
                    let mut best = canon[0];
                    for &cv in &canon {
                        if (pnt[axis] - cv).abs() < (pnt[axis] - best).abs() {
                            best = cv;
                        }
                    }
                    pnt[axis] = best;
                }
            }
        }
        let mut profiles: Vec<Vec<V2>> = Vec::with_capacity(n_slabs);
        let mut slab_area: Vec<f64> = Vec::with_capacity(n_slabs);
        let mut slab_interior: Vec<V2> = Vec::with_capacity(n_slabs);
        let mut vol = 0.0;
        for (k, mut ring) in raw_rings.into_iter().enumerate() {
            let (w_a, w_b) = (plane_ws[k], plane_ws[k + 1]);
            simplify_collinear(&mut ring, 1.0e-6 * (1.0 + mag));
            let Some(area) = ccw_area(&mut ring) else {
                continue 'cand;
            };
            // SLIVER-EDGE gate: a sub-half-millimetre profile edge sits at the
            // 0.1 mm weld/audit grid where its cut features collapse to
            // degenerate triangles and crack the closed-surface audit. Such
            // micro-features belong to the exact kernel.
            let nr = ring.len();
            for ii in 0..nr {
                let pa = ring[ii];
                let pb = ring[(ii + 1) % nr];
                let dx = pb[0] - pa[0];
                let dy = pb[1] - pa[1];
                if (dx * dx + dy * dy).sqrt() < 5.0e-4 {
                    continue 'cand;
                }
            }
            let Some(interior) = ring_interior(&ring) else {
                continue 'cand;
            };
            vol += area * (w_b - w_a);
            profiles.push(ring);
            slab_area.push(area);
            slab_interior.push(interior);
        }
        if profiles.is_empty() {
            continue;
        }
        // Volume reconcile: enclosed mesh volume ≈ Σ area × slab depth
        // (catches a section that missed part of the shape, hollow shells,
        // twisted sides, etc.).
        if !(0.98..1.02).contains(&(mesh_vol.abs() / vol)) {
            continue;
        }
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for prof in &profiles {
            for p in prof {
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
        return Some(PrismFrame {
            u,
            v,
            d,
            planes: plane_ws,
            profiles,
            slab_area,
            slab_interior,
            bb: (lo, hi),
        });
    }
    None
}
