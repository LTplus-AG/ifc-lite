// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices). `subtract`/`union`/
//! `intersection` here are what the `ClippingProcessor` seam calls.

use super::arrangement::{
    boolean, difference_all, difference_all_lenient, union_all, BoolOp, Tri,
};
use super::signed_volume::signed_volume6;
use crate::mesh::Mesh;

/// f32-near-coplanar reconciliation snap grid (metres). A POWER OF TWO so the
/// snap `(c/G).round()*G` is an EXACT f64 op ⇒ bit-deterministic across
/// x86_64/aarch64/wasm. Real IFC is authored in f32, so an intended-flush face is
/// NOT exactly coplanar after import; snapping both operands to a shared grid
/// makes such faces EXACTLY coplanar so the exact coplanar path fires instead of
/// emitting a noise sliver. Resolution is tunable against the test corpus;
/// 2^-16 m ≈ 15 µm.
///
/// Canonical definition — `tritri` and `arrangement` size their near-coplanar
/// bands to the scatter envelope this snap produces, so they import this
/// constant rather than mirroring it.
pub(crate) const SNAP_GRID: f64 = 1.0 / 65536.0;

#[inline]
fn snap(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

/// The near-coplanar perpendicular band (metres) from the operand+point
/// coordinate magnitude `extent`. `8·SNAP_GRID` is the per-axis-snap scatter
/// envelope near the origin; the `extent·2⁻²²` term widens it for far-from-
/// origin operands where f32 import is coarser.
///
/// Canonical definition — `tritri`, `classify`, and this module all size their
/// near-coplanar/scatter bands to this SAME formula, so they call this
/// function rather than mirroring the expression.
pub(crate) fn near_band_from_extent(extent: f64) -> f64 {
    (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0))
}

/// `Mesh` → the kernel's triangle list (f32 → f64, snapped to the reconcile
/// grid). Panic-free: an out-of-range index OR a non-finite (NaN/Inf) coord drops
/// that triangle rather than indexing past the end or crashing
/// `BigRational::from_float` deep in the predicates (the two empirically-found
/// reachable panic sites).
pub fn mesh_to_tris(m: &Mesh) -> Vec<Tri> {
    let vertex = |i: u32| -> Option<[f64; 3]> {
        let b = (i as usize) * 3;
        let c = [
            *m.positions.get(b)? as f64,
            *m.positions.get(b + 1)? as f64,
            *m.positions.get(b + 2)? as f64,
        ];
        if !c.iter().all(|v| v.is_finite()) {
            return None;
        }
        Some([snap(c[0]), snap(c[1]), snap(c[2])])
    };
    m.indices
        .chunks_exact(3)
        .filter_map(|c| Some([vertex(c[0])?, vertex(c[1])?, vertex(c[2])?]))
        .collect()
}

fn face_normal(t: &Tri) -> [f32; 3] {
    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 {
        [(n[0] / len) as f32, (n[1] / len) as f32, (n[2] / len) as f32]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// The kernel's triangle list → a `Mesh` (per-face flat normals, f64 → f32).
pub fn tris_to_mesh(tris: &[Tri]) -> Mesh {
    let mut m = Mesh::with_capacity(tris.len() * 3, tris.len() * 3);
    for t in tris {
        let n = face_normal(t);
        let base = (m.positions.len() / 3) as u32;
        for p in t {
            m.positions
                .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            m.normals.extend_from_slice(&n);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}


/// Orient a closed operand OUTWARD before it enters the arrangement.
///
/// The kernel boolean (`boolean_vids` / `union_all`) derives its keep/flip rules
/// from the OUTWARD-normal convention (own-solid on `−n`; the difference flips the
/// kept B faces so their caps seam with A). Real IFC winding is NOT reliably
/// outward — a CW profile extruded along `+Z`, or a faceted brep with inconsistent
/// face loops, yields an INWARD-wound (negative-signed-volume) closed solid. Fed
/// in as-is it tears the result: open boundary edges along the cut rim + an
/// inverted-volume surface (the 1007 gable-wall slivers; #1007 defect A).
///
/// We flip winding (`[a,b,c] → [a,c,b]`, an EXACT index swap) iff the signed
/// volume is negative, so every operand the kernel sees is outward. The flip is a
/// no-op for already-outward inputs (every pinned box−box manifest: `cube_mesh`
/// has volume `+8`/`+27`), so determinism manifests are unperturbed.
fn orient_outward(mut tris: Vec<Tri>) -> Vec<Tri> {
    if signed_volume6(&tris) < 0.0 {
        for t in &mut tris {
            t.swap(1, 2);
        }
    }
    tris
}

/// Cross-operand near-coincidence promotion: weld every CUTTER vertex that
/// sits within the snap-scatter band of a HOST face plane — and projects
/// STRICTLY inside that face — onto the plane, then back onto the snap grid.
///
/// WHY (found by the kernel-parity sweep on a long tunnel-wall fixture): when
/// `extend_opening_mesh_through_host` pushes a flush opening cap along the
/// host depth axis `d`, a cap corner that was bit-exactly a HOST corner can
/// slide ALONG a host face plane that contains `d` (here: the wall END face).
/// In exact arithmetic the slid corner stays on that plane, but the f32 round
/// of `p + d·shift` lands it a few µm OFF — a TILTED gap below the per-axis
/// `SNAP_GRID` reconcile (per-axis snapping cannot flatten a tilt). The host
/// EDGE then GRAZES the cutter jamb FACE at ~5e-5 rad; the conforming
/// arrangement splits the grazed face into degenerate sub-triangles whose
/// keep/drop classification is undefined → open edges + inverted volume
/// (the parity sweep's negative-volume family: 27 tris / vol −4.268 / 13 bad
/// edges from two CLEAN watertight 12-tri boxes).
///
/// The gate is PLANE-level, deliberately NOT footprint-level: in the repro the
/// cutter jamb face is PARALLEL to the host end face but 4× longer, so its
/// verts perpendicular-project 0.18–0.4 m OUTSIDE the end face's footprint —
/// a point-in-face containment test can never associate them, yet their plane
/// IS the host plane up to f32 noise. A sub-band parallel-plane separation is
/// never representable design intent (the band is three orders below the
/// smallest real feature edge, ~0.2 m — same argument as
/// `near_on_surface_normal`), so welding the vertex onto the plane only
/// removes noise. The CUTTER-ONLY direction suffices and never perturbs the
/// host. The band and far-from-origin widening mirror
/// `near_on_surface_normal` (8·SNAP_GRID ≈ 122 µm; the `extent·2⁻²²` term
/// only dominates >32 km out). DETERMINISM: plain FMA-free f64 over
/// already-snapped coords, fixed iteration order, nearest-plane ties broken
/// by face index ⇒ byte-identical native==wasm. Every pinned box−box
/// manifest is transversal (no cutter vertex within the band of a
/// non-incident host plane), so the promotion never fires there.
fn promote_cutter_verts_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) {
    if cutter.is_empty() || host.is_empty() {
        return;
    }
    let mut extent = 1.0f64;
    for t in cutter.iter().chain(host.iter()) {
        for v in t {
            for &x in v {
                extent = extent.max(x.abs());
            }
        }
    }
    let band = near_band_from_extent(extent);
    let band2 = band * band;

    struct Face {
        t0: [f64; 3],
        t1: [f64; 3],
        t2: [f64; 3],
        n: [f64; 3], // raw (unnormalised) plane normal
        nn: f64,     // |n|²
    }
    let faces: Vec<Face> = host
        .iter()
        .filter_map(|t| {
            let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
            let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if nn <= 0.0 || !nn.is_finite() {
                return None; // degenerate host triangle
            }
            Some(Face { t0: t[0], t1: t[1], t2: t[2], n, nn })
        })
        .collect();

    for t in cutter.iter_mut() {
        for v in t.iter_mut() {
            // Nearest host plane the vertex is within the band of but NOT
            // exactly on (d == 0 planes are already reconciled — and must not
            // shadow a second, still-noisy plane: in the repro the jamb verts
            // sit EXACTLY on the host bottom plane while 18–25 µm off the end
            // plane; the end plane is the one that needs the weld, and the
            // perpendicular projection onto it slides ALONG the bottom plane).
            // Ties → first in face order (deterministic).
            let mut best: Option<(f64, &Face)> = None; // (perp-dist², face)
            for f in &faces {
                let d = (v[0] - f.t0[0]) * f.n[0]
                    + (v[1] - f.t0[1]) * f.n[1]
                    + (v[2] - f.t0[2]) * f.n[2];
                if d == 0.0 {
                    continue; // already exactly on this plane
                }
                let d2 = (d * d) / f.nn;
                if d2 > band2 {
                    continue; // outside the snap-scatter band
                }
                if let Some((bd2, _)) = best {
                    if d2 >= bd2 {
                        continue;
                    }
                }
                best = Some((d2, f));
            }
            // EXACT-PLANE LIFT (the crack-family fix): re-express the foot of
            // the perpendicular in the host triangle's EDGE BASIS and recombine
            // it with EXACT f64 arithmetic, so the welded vertex lies EXACTLY on
            // the host face's plane (orient3d == Zero) and the exact coplanar
            // carve fires — A/B seam vertices then intern to identical Vids.
            // The previous per-axis `snap()` of the foot re-scattered it 3–13 µm
            // OFF a tilted plane (per-axis snapping cannot hold a tilt), so the
            // tri-pair classified Segment/near-coplanar and the carve chords of
            // the two operands diverged by mm in-plane ⇒ exact-coordinate
            // boundary cracks on far-from-origin walls. On a weld failure
            // (degenerate basis / out-of-range / inexact recombination) the
            // vertex is left UNTOUCHED — never an inexact foot, which would be
            // off every grid and force the BigRational tier on every predicate
            // that sees it.
            if let Some((_, f)) = best {
                if let Some(w) = exact_on_plane_weld(*v, f.t0, f.t1, f.t2) {
                    *v = w;
                }
            }
        }
    }
}

/// Weld `v` onto the plane of the (snap-grid) host triangle `(t0,t1,t2)` such
/// that the result is EXACTLY on that plane and EXACTLY representable in f64.
///
/// The foot is solved in the triangle's edge basis (Gram system over `u=t1−t0`,
/// `w=t2−t0`), then α,β are quantized to the 2⁻²⁰ grid and the point
/// `t0 + α·u + β·w` is recombined in INTEGER arithmetic on the 2⁻³⁶ grid
/// (operands are k/2¹⁶ ⇒ α·u terms are k/2³⁶ exactly). Any α,β on that grid
/// yields a point mathematically ON the plane; the only requirement is that the
/// f64 result is exact, which the i128 round-trip check enforces (and which
/// bounds every magnitude case — huge georef coords simply fail the check and
/// skip the weld). The in-plane quantization shift is ≤ edge·2⁻²⁰ (µm). The
/// f64 Gram solve itself may round — harmless, it only picks WHICH on-grid
/// (α,β) is used. |α|,|β| ≤ 8 bounds the integer products (the perpendicular
/// foot of a band-near vertex is always within a few edge lengths; anything
/// farther is a degenerate sliver basis we refuse to weld with).
///
/// DETERMINISM: FMA-free f64 + integer ops, fixed iteration order ⇒
/// byte-identical native==wasm.
fn exact_on_plane_weld(v: [f64; 3], t0: [f64; 3], t1: [f64; 3], t2: [f64; 3]) -> Option<[f64; 3]> {
    const Q: f64 = 1_048_576.0; // 2^20 — α,β quantization
    const S16: f64 = 65_536.0; // the operand snap grid (1/SNAP_GRID)
    const S36: f64 = 68_719_476_736.0; // 2^36 = S16 · Q — the welded-vertex grid
    let u = [t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]];
    let w = [t2[0] - t0[0], t2[1] - t0[1], t2[2] - t0[2]];
    let p = [v[0] - t0[0], v[1] - t0[1], v[2] - t0[2]];
    let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (uu, ww, uw) = (dot(&u, &u), dot(&w, &w), dot(&u, &w));
    let (pu, pw) = (dot(&p, &u), dot(&p, &w));
    let det = uu * ww - uw * uw;
    if det == 0.0 || !det.is_finite() {
        return None; // degenerate (collinear) edge basis
    }
    let alpha = ((ww * pu - uw * pw) / det * Q).round();
    let beta = ((uu * pw - uw * pu) / det * Q).round();
    if !alpha.is_finite() || !beta.is_finite() || alpha.abs() > 8.0 * Q || beta.abs() > 8.0 * Q {
        return None;
    }
    let (ai, bi) = (alpha as i128, beta as i128);
    let mut out = [0.0f64; 3];
    for k in 0..3 {
        // scale the on-grid coords to integers (k/2^16 · 2^16); a coordinate
        // off the snap grid (or too large to scale exactly) refuses the weld.
        let (s0, s1, s2) = (t0[k] * S16, t1[k] * S16, t2[k] * S16);
        for s in [s0, s1, s2] {
            if s.fract() != 0.0 || s.abs() >= 9.0e18 {
                return None;
            }
        }
        let (i0, i1, i2) = (s0 as i128, s1 as i128, s2 as i128);
        // the welded coordinate on the 2^-36 grid: t0·2^20 + α·u + β·w
        let r36 = (i0 << 20) + ai * (i1 - i0) + bi * (i2 - i0);
        let rf = r36 as f64;
        if rf as i128 != r36 {
            return None; // not exactly representable in f64 ⇒ skip the weld
        }
        out[k] = rf / S36; // power-of-two divide: exact
    }
    Some(out)
}

/// `host − cutter` as a `Mesh`.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    #[cfg(feature = "csg_capture")]
    crate::csg_capture::record_single(host, cutter);
    let h = orient_outward(mesh_to_tris(host));
    let mut c = mesh_to_tris(cutter);
    promote_cutter_verts_onto_host_faces(&mut c, &h);
    let c = orient_outward(c);
    tris_to_mesh(&boolean(&h, &c, BoolOp::Difference))
}

/// `host − (∪ cutters)` as a `Mesh` — the batched void-group subtract.
///
/// The cutters MUST be pairwise disjoint (the router groups by snap-band-
/// inflated AABBs) and each per-component watertight. Every component is
/// promoted onto the host faces and oriented outward INDIVIDUALLY — the global
/// signed-volume orientation of [`subtract`] cannot fix mixed per-component
/// winding of a multi-component operand (the #2176 lesson) — then the whole
/// group is subtracted in ONE arrangement (`difference_all_volume_safe`), so
/// there is no per-cutter f64→f32→snap round-trip to re-jitter and re-crack the
/// previous cut's seams. Component order is the caller's (deterministic).
/// Returns `None` only when even the volume-safe non-conforming batch is
/// untrustworthy; the caller then falls back to sequential per-cutter subtraction.
pub fn subtract_many(host: &Mesh, cutters: &[&Mesh]) -> Option<Mesh> {
    #[cfg(feature = "csg_capture")]
    crate::csg_capture::record_many(host, cutters);
    let h = orient_outward(mesh_to_tris(host));
    let comp_tris: Vec<Vec<Tri>> = cutters
        .iter()
        .map(|m| {
            let mut c = mesh_to_tris(m);
            promote_cutter_verts_onto_host_faces(&mut c, &h);
            orient_outward(c)
        })
        .collect();
    let refs: Vec<&[Tri]> = comp_tris.iter().map(|c| c.as_slice()).collect();
    // Conforming batch: the fast, exact, byte-identical common path.
    if let Some(r) = difference_all(&h, &refs) {
        return Some(tris_to_mesh(&r));
    }
    // Non-conforming batch (an unrecovered constraint remains after the robust
    // traversal recovery). Its exact topology is CLEANER than sequential per-cutter
    // re-jitter on dense faceted-reveal walls (issue #098 V5C: 532→108 open edges),
    // but a straddling misclassification can over/under-cut VOLUME (#559171/#1167).
    // Trust the lenient batch ONLY when its removed volume matches the true removed
    // volume; else None, so the caller runs its full sequential path.
    let batch = difference_all_lenient(&h, &refs);
    // ORACLE for the volume comparison (#1788): batched cutters are pairwise
    // disjoint (this fn's contract), so the TRUE removed volume is
    // Σ |host ∩ cutterᵢ| — each a small single boolean against the PRISTINE
    // host, the well-conditioned regime. The previous oracle re-ran the
    // sequential subtract chain, but that chain re-jitters its own seams
    // cut-over-cut and UNDER-cuts on multi-void walls — on the ISSUE_098
    // Poroton wall its "reference" removed 2% less volume than the (correct)
    // batch, so a perfect batch was rejected in favour of the broken
    // sequential fallback, leaving an opening uncut (T6 fail:opening-not-cut).
    // Budget snapshot/restore: oracle work isn't charged to the caller's
    // batch budget (codex P2 on #1660); a trip DURING an oracle intersection
    // makes its volume untrustworthy ⇒ reject the group (as before).
    let budget_snap = super::budget::snapshot_counters();
    let mut inter_sum = 0.0f64;
    let mut oracle_tripped = false;
    for c in &comp_tris {
        super::budget::begin();
        let i = boolean(&h, c, BoolOp::Intersection);
        if super::budget::tripped() {
            oracle_tripped = true;
            break;
        }
        inter_sum += signed_volume6(&i).abs();
    }
    super::budget::restore_counters(budget_snap);
    if oracle_tripped {
        return None;
    }
    let host_v = signed_volume6(&h).abs();
    let batch_removed = host_v - signed_volume6(&batch).abs();
    // 1% agreement — above f64/FMA noise (parity-stable branch), tight enough to
    // reject the #1167 gross under-cut (3.7 m³ vs 13 m³).
    let tol = inter_sum.abs().max(1.0e-9) * 0.01;
    if (batch_removed - inter_sum).abs() <= tol {
        Some(tris_to_mesh(&batch))
    } else {
        None
    }
}

/// `a ∪ b` as a `Mesh`.
pub fn union(a: &Mesh, b: &Mesh) -> Mesh {
    // Enter the #1109 escalation budget exactly like `subtract` does: begin a
    // fresh PER-BOOLEAN count (this is a distinct operation) while the per-ELEMENT
    // accumulator is left intact — `begin()` resets only the per-op counter, so a
    // union inside an over-budget element STILL trips (it is not an element-cap
    // escape hatch; see `budget::begin` / the `per_element_budget_accumulates_
    // across_booleans` test). Without this, a union scheduled on a worker thread
    // after a subtract tripped starts already-tripped and `arrange` bails at its
    // first pair, silently returning a partial/empty arrangement.
    super::budget::begin();
    let a = orient_outward(mesh_to_tris(a));
    let b = orient_outward(mesh_to_tris(b));
    let out = boolean(&a, &b, BoolOp::Union);
    // On a budget trip `arrange` bailed mid-way and `out` is a PARTIAL arrangement.
    // Discard it and return empty — the graceful-fallback signal the callers already
    // handle (`csg::union_mesh` degrades to a plain merge; the #960 roof
    // `build_cutter_union` defers to the sequential path) — never a poisoned mesh.
    // Deterministic: the trip point is a pure function of the snapped operands, so
    // native and wasm degrade the SAME union identically (parity).
    if super::budget::tripped() {
        return Mesh::new();
    }
    tris_to_mesh(&out)
}

/// `∪ meshes` as one watertight `Mesh` — the N-ary union, computed in a single
/// conforming arrangement so coplanar seams shared by 3+ operands (the #960
/// segmented-roof cutters) dissolve without the tearing that left-deep pairwise
/// accumulation produces. Empty input ⇒ empty mesh.
pub fn union_many(meshes: &[&Mesh]) -> Mesh {
    // Participate in the #1109 budget like `subtract` / `union` — fresh per-boolean
    // count, per-element accumulator preserved (see `union`).
    super::budget::begin();
    let tri_lists: Vec<Vec<Tri>> =
        meshes.iter().map(|m| orient_outward(mesh_to_tris(m))).collect();
    let refs: Vec<&[Tri]> = tri_lists.iter().map(|t| t.as_slice()).collect();
    let (out, conforming) = union_all(&refs);
    // #1109 budget trip ⇒ `arrange_many` bailed and `out` is PARTIAL; return empty so
    // `build_cutter_union` defers to the sequential per-cutter path instead of feeding
    // a poisoned (non-watertight) cutter union into the subtract.
    if super::budget::tripped() {
        return Mesh::new();
    }
    // `!conforming` ⇒ an unrecovered constraint left the arrangement non-conforming —
    // `union_all` now SURFACES the condition `difference_all` hard-rejects (vs the old
    // silent discard). We deliberately trust the union anyway: the sole caller (#960
    // `build_cutter_union`) verifies the downstream subtract, and the exact batched
    // union — even a torn one — beats the sequential fallback that reintroduces the
    // seam sliver #960 removed (wall #4148: exact → 8984 mm; fallback → 9850 mm).
    let _ = conforming;
    tris_to_mesh(&out)
}

/// `a ∩ b` as a `Mesh`.
pub fn intersection(a: &Mesh, b: &Mesh) -> Mesh {
    // Participate in the #1109 budget like `subtract` / `union` — fresh per-boolean
    // count, per-element accumulator preserved (see `union`).
    super::budget::begin();
    let a = orient_outward(mesh_to_tris(a));
    let b = orient_outward(mesh_to_tris(b));
    let out = boolean(&a, &b, BoolOp::Intersection);
    // On a budget trip `arrange` bailed and `out` is a PARTIAL arrangement. Return
    // empty — `csg::intersection_mesh` treats empty as the graceful (disjoint-like)
    // degrade rather than consuming a poisoned partial intersection.
    if super::budget::tripped() {
        return Mesh::new();
    }
    tris_to_mesh(&out)
}

#[cfg(test)]
mod tests {
    use super::super::arrangement::cube_mesh;
    use super::*;

    fn mesh_volume(m: &Mesh) -> f64 {
        let vertex = |i: u32| {
            let b = (i as usize) * 3;
            [
                m.positions[b] as f64,
                m.positions[b + 1] as f64,
                m.positions[b + 2] as f64,
            ]
        };
        m.indices
            .chunks_exact(3)
            .map(|c| {
                let (a, bb, cc) = (vertex(c[0]), vertex(c[1]), vertex(c[2]));
                let cr = [
                    bb[1] * cc[2] - bb[2] * cc[1],
                    bb[2] * cc[0] - bb[0] * cc[2],
                    bb[0] * cc[1] - bb[1] * cc[0],
                ];
                a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
            })
            .sum::<f64>()
            / 6.0
    }

    #[test]
    fn snap_reconciles_near_coplanar_and_is_deterministic() {
        // coords closer than the grid snap to the SAME value (f32-flush → exact)
        assert_eq!(super::snap(1.0), super::snap(1.0 + 1e-6));
        assert_eq!(super::snap(2.5), super::snap(2.5 - 5e-6));
        // grid multiples (incl. integers) are exact fixed points
        assert_eq!(super::snap(3.0), 3.0);
        assert_eq!(super::snap(0.0), 0.0);
        assert_eq!(super::snap(7.0 / 65536.0), 7.0 / 65536.0);
        // distinct grid cells stay distinct
        assert_ne!(super::snap(1.0), super::snap(1.0 + 1e-3));
    }

    /// `mesh_to_tris` is documented panic-free against a triangle whose vertex
    /// index runs past the end of `positions` (a truncated/corrupt buffer):
    /// the offending triangle is silently dropped rather than indexing OOB.
    #[test]
    fn mesh_to_tris_drops_out_of_range_index_without_panicking() {
        let mut m = Mesh::new();
        // one real triangle (verts 0,1,2)...
        m.positions.extend_from_slice(&[0.0, 0.0, 0.0]);
        m.positions.extend_from_slice(&[1.0, 0.0, 0.0]);
        m.positions.extend_from_slice(&[0.0, 1.0, 0.0]);
        // ...then a second face referencing vertex index 5, which is past the
        // end of a 3-vertex positions buffer (truncated/corrupt data).
        m.indices.extend_from_slice(&[0, 1, 2, 0, 1, 5]);

        let tris = mesh_to_tris(&m);

        assert_eq!(tris.len(), 1, "malformed triangle (OOB index) must be dropped, not panic");
        assert_eq!(tris[0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
    }

    /// `mesh_to_tris` is documented panic-free against a non-finite (NaN/Inf)
    /// position coordinate: the offending triangle is silently dropped rather
    /// than propagating NaN into the exact-predicate kernel.
    #[test]
    fn mesh_to_tris_drops_non_finite_coordinate_without_panicking() {
        let mut m = Mesh::new();
        // valid triangle (verts 0,1,2)
        m.positions.extend_from_slice(&[0.0, 0.0, 0.0]);
        m.positions.extend_from_slice(&[1.0, 0.0, 0.0]);
        m.positions.extend_from_slice(&[0.0, 1.0, 0.0]);
        // NaN-poisoned vertex 3, referenced by a second face
        m.positions.extend_from_slice(&[f32::NAN, 0.0, 0.0]);
        // Inf-poisoned vertex 4, referenced by a third face
        m.positions.extend_from_slice(&[f32::INFINITY, 0.0, 0.0]);
        m.indices
            .extend_from_slice(&[0, 1, 2, 0, 1, 3, 0, 1, 4]);

        let tris = mesh_to_tris(&m);

        assert_eq!(
            tris.len(),
            1,
            "triangles touching a NaN or Inf coordinate must be dropped, not panic"
        );
        assert_eq!(tris[0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
    }

    #[test]
    fn kernel_cuts_a_real_mesh() {
        // Round-trip through ifc-lite's Mesh: two cube meshes, subtract via the
        // kernel, and the result Mesh has the exact box−box volume.
        let host = tris_to_mesh(&cube_mesh(0.0, 2.0)); // vol 8
        let cutter = tris_to_mesh(&cube_mesh(1.0, 3.0)); // overlap [1,2]³ = 1
        let result = subtract(&host, &cutter);
        assert!(!result.indices.is_empty(), "subtract produced an empty mesh");
        let v = mesh_volume(&result);
        assert!((v - 7.0).abs() < 1e-3, "Mesh host−cutter volume = {v}, expected 7");
        // sanity: the round-tripped host mesh has volume 8
        assert!((mesh_volume(&host) - 8.0).abs() < 1e-4, "host round-trip volume wrong");
    }

    #[test]
    fn kernel_cuts_a_through_wall_opening() {
        use super::super::arrangement::box_mesh;
        // a thin wall slab with a box opening poking all the way through (z)
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [4., 3., 0.2])); // vol 2.4
        let opening = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole vol 0.2
        let result = subtract(&wall, &opening);
        let v = mesh_volume(&result);
        assert!((v - 2.2).abs() < 1e-3, "through-opening wall volume = {v}, expected 2.2");
    }

    /// Extended-cutter-graze regression (a rotated tunnel-wall fixture): a
    /// rotated 12-tri host box minus the cutter box that
    /// `extend_opening_mesh_through_host` pushed through it. The push slid a
    /// bit-exactly-shared corner ALONG the host end-face plane; the f32 round
    /// left it ~8 µm off (a tilt the per-axis snap can't flatten), so a host
    /// edge GRAZED the cutter jamb face and the subtract emitted 27 tris /
    /// 13 open edges / signed volume −4.268 (vs Manifold's +3.182871 on the
    /// SAME operands). The cross-operand promotion welds the slid corner back
    /// onto the host plane; the cut must be watertight with the oracle volume.
    #[test]
    fn extended_cutter_graze_subtracts_exactly() {
        fn mesh_of(vs: &[[f32; 3]], fs: &[[u32; 3]]) -> Mesh {
            let mut m = Mesh::new();
            for v in vs {
                m.positions.extend_from_slice(v);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            for f in fs {
                m.indices.extend_from_slice(f);
            }
            m
        }
        // exact f32 coords as dumped from the failing host/cutter pair;
        // 8 unique verts each, both watertight.
        let host = mesh_of(
            &[
                [274.05923, 400.96225, 34.600006],
                [276.68744, 404.85873, 34.600006],
                [276.52164, 404.97058, 34.600006],
                [274.00525, 401.2399, 34.600006],
                [274.05923, 400.96225, 38.600006],
                [276.68744, 404.85873, 38.600006],
                [276.52164, 404.97058, 38.600006],
                [274.00525, 401.2399, 38.600006],
            ],
            &[
                [3, 1, 0], [1, 3, 2], [7, 4, 5], [5, 6, 7], [0, 1, 5], [0, 5, 4],
                [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
            ],
        );
        let cutter = mesh_of(
            &[
                [277.01904, 404.63507, 34.6],
                [276.39276, 403.70654, 34.6],
                [276.39276, 403.70654, 36.82],
                [277.01904, 404.63507, 36.82],
                [276.3724, 405.07123, 34.6],
                [275.7461, 404.1427, 34.6],
                [275.7461, 404.1427, 36.82],
                [276.3724, 405.07123, 36.82],
            ],
            &[
                [2, 0, 3], [0, 2, 1], [6, 7, 4], [4, 5, 6], [0, 1, 5], [0, 5, 4],
                [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
            ],
        );
        assert!((mesh_volume(&host) - 3.680154).abs() < 1e-4, "host operand changed");
        assert!((mesh_volume(&cutter) - 1.939390).abs() < 1e-4, "cutter operand changed");
        let result = subtract(&host, &cutter);
        let v = mesh_volume(&result);
        // Manifold oracle on the same operands: +3.182871 (pure on the
        // UNextended cutter: +3.18291). f32 round-trip noise stays ≪ 1e-3.
        assert!((v - 3.182871).abs() < 1e-3, "subtract volume = {v}, expected ≈3.182871");
        // watertight: every directed edge must be paired (the broken cut had 13 bad)
        let s = 1e5_f32;
        let key = |i: u32| {
            let b = i as usize * 3;
            (
                (result.positions[b] * s).round() as i64,
                (result.positions[b + 1] * s).round() as i64,
                (result.positions[b + 2] * s).round() as i64,
            )
        };
        let mut edges = std::collections::HashMap::new();
        for t in result.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((key(a), key(b))).or_insert(0i32) += 1;
                *edges.entry((key(b), key(a))).or_insert(0i32) -= 1;
            }
        }
        let bad = edges.values().filter(|&&c| c != 0).count();
        assert_eq!(bad, 0, "result has {bad} unpaired directed edges");
    }

    /// Directed-edge pairing audit at EXACT f32-bit coordinates — the crack
    /// detector. A watertight oriented surface has every directed edge matched
    /// by its reverse; any imbalance is an exact-coordinate boundary crack
    /// (the crack family). No rounding: two seam vertices that differ by
    /// even one ULP count as a crack, which is precisely the defect.
    fn exact_open_edges(m: &Mesh) -> usize {
        use std::collections::HashMap;
        let key = |i: u32| {
            let b = i as usize * 3;
            (
                m.positions[b].to_bits(),
                m.positions[b + 1].to_bits(),
                m.positions[b + 2].to_bits(),
            )
        };
        let mut edges: HashMap<_, i64> = HashMap::new();
        for t in m.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((key(a), key(b))).or_insert(0) += 1;
                *edges.entry((key(b), key(a))).or_insert(0) -= 1;
            }
        }
        edges.values().filter(|&&c| c != 0).count()
    }

    fn mesh_of(vs: &[[f32; 3]], fs: &[[u32; 3]]) -> Mesh {
        let mut m = Mesh::new();
        for v in vs {
            m.positions.extend_from_slice(v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        for f in fs {
            m.indices.extend_from_slice(f);
        }
        m
    }

    /// Standard 8-vert box/prism face table (bottom quad 0-3, top quad 4-7).
    const PRISM_FACES: [[u32; 3]; 12] = [
        [3, 1, 0], [1, 3, 2], [7, 4, 5], [5, 6, 7], [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    const BOX_FACES: [[u32; 3]; 12] = [
        [2, 0, 3], [0, 2, 1], [6, 7, 4], [4, 5, 6], [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];

    /// Crack-family regression (a far-from-origin tunnel wall, step 0 of the
    /// minimal repro): a clean 12-tri plan-rotated wall prism minus ONE small
    /// recess box whose jamb face is intended-flush with the TILTED host end
    /// plane (they share the host corner (300.84857, 362.50748) bit-exactly;
    /// the other jamb verts sit ~24 µm off-plane after the per-axis 2^-16
    /// snap). Pre-fix the near-coplanar carve ran on the still-off-plane
    /// coordinates, the A/B seam vertices never interned identically, and the
    /// cut emitted 16 exact-coordinate open edges with volume 0.107 instead of
    /// the analytic 0.306705. The exact-plane lift welds the jamb verts EXACTLY
    /// onto the host plane so the coplanar carve conforms: watertight + exact.
    #[test]
    fn tilted_flush_recess_cut_is_watertight_198779() {
        let host = mesh_of(
            &[
                [301.04767, 363.11743, 47.6],
                [300.70264, 362.6059, 47.6],
                [300.84857, 362.50748, 47.6],
                [301.24, 363.08783, 47.6],
                [301.04767, 363.11743, 50.25],
                [300.70264, 362.6059, 50.25],
                [300.84857, 362.50748, 50.25],
                [301.24, 363.08783, 50.25],
            ],
            &PRISM_FACES,
        );
        let cutter = mesh_of(
            &[
                [300.85583, 362.51828, 47.6],
                [300.84506, 362.52554, 47.6],
                [300.8378, 362.51477, 47.6],
                [300.84857, 362.50748, 47.6],
                [300.85583, 362.51828, 50.25],
                [300.84506, 362.52554, 50.25],
                [300.8378, 362.51477, 50.25],
                [300.84857, 362.50748, 50.25],
            ],
            &BOX_FACES,
        );
        let result = subtract(&host, &cutter);
        let open = exact_open_edges(&result);
        assert_eq!(open, 0, "tilted-flush recess cut left {open} exact-coordinate open edges");
        let v = mesh_volume(&result);
        assert!(
            (v - 0.306705).abs() < 1e-3,
            "recess cut volume = {v}, expected ≈0.306705 (analytic; pre-fix 0.107)"
        );
    }

    /// Crack-family regression (the +10.3% max-error row of the far-from-origin
    /// sweep): an 8×8-tri body `IfcBooleanClippingResult` DIFF in
    /// native units (|y|≈6699 ⇒ one f32 ULP = 4.88e-4 ≈ 32 snap cells, so the
    /// per-axis 2^-16 snap is structurally unable to reconcile the flush slant
    /// plane). The cutter's bottom face is intended-flush with the host's slant
    /// plane but 1 ULP off; pre-fix the cut emitted a 13-tri open result (16
    /// exact open edges) at +10.3% vs IfcOpenShell. Post-fix the kernel output
    /// is exactly closed at f32 with volume at IOS parity: 5868311718 mm³ =
    /// 5.8683117 m³ vs IfcOpenShell 0.8.2's 5.868313 m³ (2.6e-7 relative).
    #[test]
    fn native_unit_flush_slant_diff_is_watertight_387738() {
        let host = mesh_of(
            &[
                [478.50012207031250, -0.0000457763671875, 0.0],
                [3580.001708984375, -6699.17578125, 167.4681396484375],
                [-1764.322265625, -6699.17578125, 167.4681396484375],
                [478.50012207031250, -0.0000457763671875, 499.907318115234375],
                [-1764.322265625, -6699.17578125, 667.37548828125],
                [3580.001708984375, -6699.17578125, 667.37548828125],
            ],
            &[
                [0, 1, 2], [3, 4, 5], [2, 1, 5], [2, 5, 4],
                [1, 0, 3], [1, 3, 5], [0, 2, 4], [0, 4, 3],
            ],
        );
        let cutter = mesh_of(
            &[
                [-1764.322113037109375, -6699.175338745117188, 283.737548828125],
                [478.50012207031250, -0.0000457763671875, 283.737548828125],
                [478.50012207031250, -0.0000457763671875, 0.0],
                [-1764.322265625, -6699.17529296875, 167.468124389648438],
                [3580.0015258789062, -6699.175384521484375, 283.737548828125],
                [3580.001708984375, -6699.17529296875, 167.468124389648438],
            ],
            &[
                [0, 1, 2], [0, 2, 3], [4, 1, 0], [1, 4, 5],
                [1, 5, 2], [5, 3, 2], [4, 0, 3], [4, 3, 5],
            ],
        );
        let host_vol = mesh_volume(&host);
        let result = subtract(&host, &cutter);
        let open = exact_open_edges(&result);
        assert_eq!(open, 0, "flush-slant DIFF left {open} exact-coordinate open edges");
        let v = mesh_volume(&result);
        // The kept part is the host above the flush z≈283.74 cut plane
        // (pre-fix: open 13-tri garbage at +10.3% vs the oracle).
        assert!(
            v > 0.0 && v < host_vol,
            "DIFF volume {v} not inside (0, host {host_vol})"
        );
        let expected = 5.868313e9_f64; // IfcOpenShell 0.8.2, mm³
        assert!(
            (v - expected).abs() / expected < 1e-5,
            "DIFF volume = {v}, expected ≈{expected} (IfcOpenShell oracle)"
        );
    }

    #[test]
    fn kernel_cuts_two_sequential_openings() {
        use super::super::arrangement::box_mesh;
        // The void-router pattern: a host cut by several openings in sequence,
        // each subtract's OUTPUT fed back in as the next host.
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 3., 0.2])); // vol 3.6
        let op1 = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole 0.2
        let op2 = tris_to_mesh(&box_mesh([4., 1., -0.5], [5., 2., 0.7])); // hole 0.2
        let after2 = subtract(&subtract(&wall, &op1), &op2);
        let v = mesh_volume(&after2);
        assert!((v - 3.2).abs() < 1e-3, "two-opening wall volume = {v}, expected 3.2");
    }

    /// Tangential-touch conformity regression (the `TriTri::Point` fix): a
    /// window box whose top-left corner lands EXACTLY on the host face
    /// triangle's diagonal (z = x/2 at x=4). The lower face triangle sees the
    /// window-top intersection as a SEGMENT ending on the diagonal and splits
    /// it there; the upper triangle's intersection with the window top is just
    /// that single POINT — pre-fix it was discarded, the upper triangle never
    /// split its edge, and the resulting T-junction opened 12 exact-coordinate
    /// edges on a plain binary subtract. The touch point is now interned as a
    /// conformity vertex in BOTH triangles (`RetriInput::points`).
    #[test]
    fn tangential_touch_on_host_diagonal_is_watertight() {
        use super::super::arrangement::box_mesh;
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 0.2, 3.])); // vol 3.6
        let window = tris_to_mesh(&box_mesh([4., -0.3, 0.5], [5., 0.5, 2.0])); // corner on diag
        let result = subtract(&wall, &window);
        let open = exact_open_edges(&result);
        assert_eq!(open, 0, "tangential-touch cut left {open} exact open edges");
        let v = mesh_volume(&result);
        assert!((v - 3.3).abs() < 1e-3, "window cut volume = {v}, expected 3.3");
    }

    /// Batching: a two-pocket batched group (flush-bottom door + a window whose
    /// corner touches the face diagonal) must equal the sequential chain and
    /// stay watertight — the configuration that exposed both the tangential-
    /// touch defect and the swallowed-endpoint constraint-recovery bail.
    #[test]
    fn subtract_many_two_pocket_group_matches_sequential() {
        use super::super::arrangement::box_mesh;
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 0.2, 3.])); // vol 3.6
        let door = tris_to_mesh(&box_mesh([1., -1.0, 0.0], [2., 1.2, 2.5])); // flush bottom
        let window = tris_to_mesh(&box_mesh([4., -0.3, 0.5], [5., 0.5, 2.0]));
        let seq = subtract(&subtract(&wall, &door), &window);
        let many = subtract_many(&wall, &[&door, &window]).expect("group must conform");
        let (vs, vm) = (mesh_volume(&seq), mesh_volume(&many));
        let om = exact_open_edges(&many);
        assert_eq!(om, 0, "batched two-pocket cut left {om} exact open edges");
        assert!(
            (vs - vm).abs() < 1e-6,
            "batched volume {vm} != sequential volume {vs} on disjoint cutters"
        );
    }

    /// Disjoint-cutter batching: `subtract_many` of three pairwise-
    /// disjoint through-openings in ONE arrangement equals the sequential
    /// per-cutter chain (analytic volume), is watertight, and is robust to a
    /// component arriving INWARD-wound — the per-component orientation inside
    /// `subtract_many` must fix it (a global signed-volume orientation of the
    /// concatenated soup cannot; the #2176 lesson).
    #[test]
    fn subtract_many_disjoint_openings_matches_sequential() {
        use super::super::arrangement::box_mesh;
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [9., 3., 0.2])); // vol 5.4
        let op1 = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole 0.2
        let mut op2 = tris_to_mesh(&box_mesh([4., 1., -0.5], [5., 2., 0.7])); // hole 0.2
        let op3 = tris_to_mesh(&box_mesh([7., 1., -0.5], [8., 2., 0.7])); // hole 0.2
        // flip op2's winding inward — per-component orientation must recover it
        for t in op2.indices.chunks_exact_mut(3) {
            t.swap(1, 2);
        }
        let batched = subtract_many(&wall, &[&op1, &op2, &op3])
            .expect("disjoint box group must conform");
        let v = mesh_volume(&batched);
        assert!((v - 4.8).abs() < 1e-3, "batched 3-opening wall volume = {v}, expected 4.8");
        let open = exact_open_edges(&batched);
        assert_eq!(open, 0, "batched cut left {open} exact-coordinate open edges");
        // parity with the sequential chain
        let seq = subtract(&subtract(&subtract(&wall, &op1), &op2), &op3);
        let vs = mesh_volume(&seq);
        assert!(
            (v - vs).abs() < 1e-6,
            "batched volume {v} != sequential volume {vs} on disjoint cutters"
        );
    }
}
