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

/// f32-near-coplanar reconciliation snap grid, in the CALLER's unit — NOT
/// metres (#2684): 15 µm on the METRE path (`router/layers`), 15 nm on the
/// FILE-UNIT boolean path, where f32 import noise is ~7.6 µm either way, so a
/// millimetre file's snap moves nothing. `csg/plane_eps.rs` records the same
/// divergence for the clipper's floor; `tests/snap_grid_unit_denomination.rs`
/// measures it. A POWER OF TWO so `(c/G).round()*G` is an EXACT f64 op ⇒
/// bit-deterministic across x86_64/aarch64/wasm. Real IFC is f32-authored, so an
/// intended-flush face is NOT exactly coplanar after import; a shared grid makes
/// such faces EXACTLY coplanar, firing the exact path instead of a noise sliver.
///
/// Canonical definition — `tritri` and `arrangement` size their near-coplanar
/// bands to the scatter envelope this snap produces, so they import this
/// constant rather than mirroring it.
pub(crate) const SNAP_GRID: f64 = 1.0 / 65536.0;

#[inline]
fn snap(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

// The near-coplanar perpendicular band lives in `super::near_band`: it keeps
// the operand extent PER AXIS and projects it onto the plane normal actually
// being tested. `tritri`, `classify` and this module all size their
// near-coplanar/scatter bands with that ONE type rather than mirroring the
// expression.
use super::near_band::NearBand;

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
pub(crate) fn orient_outward(mut tris: Vec<Tri>) -> Vec<Tri> {
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
/// host. The band and its far-from-origin widening mirror
/// `near_on_surface_normal`: [`NearBand`], sized PER HOST PLANE from the
/// operands' per-axis extents projected onto that plane's own normal
/// (8·SNAP_GRID until the projected extent passes ~512 CALLER units, not metres
/// (#2684), so an offset along an axis this plane does not face never widens it).
/// DETERMINISM: plain FMA-free f64 over
/// already-snapped coords, fixed iteration order, nearest-plane ties broken
/// by face index ⇒ byte-identical native==wasm. Every pinned box−box
/// manifest is transversal (no cutter vertex within the band of a
/// non-incident host plane), so the promotion never fires there.
fn promote_cutter_verts_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) {
    if cutter.is_empty() || host.is_empty() {
        return;
    }
    let mut band = NearBand::default();
    band.observe_tris(cutter);
    band.observe_tris(host);

    struct Face {
        t0: [f64; 3],
        t1: [f64; 3],
        t2: [f64; 3],
        n: [f64; 3], // raw (unnormalised) plane normal
        nn: f64,     // |n|²
        /// Squared PERPENDICULAR band for THIS face's plane. `NearBand`
        /// returns it scaled by `nn` (its comparisons are made against a raw
        /// `d = dot(v − t0, n)`); the `/ nn` here puts it back into true
        /// distance units, because the nearest-plane search below compares
        /// `d²/nn` ACROSS faces with different `|n|`.
        band2: f64,
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
            let band2 = band.scaled_band2(n, nn) / nn;
            Some(Face { t0: t[0], t1: t[1], t2: t[2], n, nn, band2 })
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
                if d2 > f.band2 {
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

/// `a ∩ b` as the kernel's own exact f64 triangles, WITHOUT the `Mesh` round-trip.
///
/// `Mesh` stores positions as `f32`, so `intersection` below loses ~1e-7 of
/// relative precision on the way out. That is irrelevant for a render buffer and
/// very relevant for anything that measures the result: on the analytic
/// rotated-box oracle the f64 triangles give exactly 9.375 m³ where the `Mesh`
/// round-trip gives 9.374999882. Callers that report a VOLUME (the clash
/// intersection solid, `crate::clash_solid`) take this entry; callers that only
/// need triangles to draw take `intersection`.
///
/// Empty on a #1109 budget trip, exactly like `intersection`.
pub fn intersection_tris(a: &Mesh, b: &Mesh) -> Vec<Tri> {
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
        return Vec::new();
    }
    out
}

/// `a ∩ b` as a `Mesh`.
pub fn intersection(a: &Mesh, b: &Mesh) -> Mesh {
    tris_to_mesh(&intersection_tris(a, b))
}

#[cfg(test)]
#[path = "mesh_bridge_tests.rs"]
mod tests;
