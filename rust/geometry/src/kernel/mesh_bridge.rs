// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices). `subtract`/`union`/
//! `intersection` here are what the `ClippingProcessor` seam calls.

use super::arrangement::{
    boolean, boolean_with_conformity, difference_all, difference_all_lenient, BoolOp,
    Tri,
};
use super::signed_volume::signed_volume6;
use crate::mesh::Mesh;

/// f32-near-coplanar reconciliation snap grid, in the CALLER's unit — NOT
/// metres (#2684): 15 µm on the METRE path (`router/voids`), 15 nm on the
/// FILE-UNIT boolean path. Past |c| = 128 CALLER UNITS the f32 spacing is
/// itself a multiple of the grid, so every f32 is already on it and the snap
/// is INERT — 12.8 cm in a millimetre file (so all of it), 128 m in a metre
/// one. `csg/plane_eps.rs` records the same divergence for the clipper's
/// floor; `tests/snap_grid_unit_denomination.rs` measures both. A POWER OF TWO
/// so `(c/G).round()*G` is EXACT f64 ⇒ bit-deterministic across
/// x86_64/aarch64/wasm. Real IFC is f32-authored, so an intended-flush face is
/// NOT coplanar after import; the grid is what makes it so.
///
/// Canonical definition — `tritri` and `arrangement` size their near-coplanar
/// bands to the scatter envelope this snap produces, so they import this
/// constant rather than mirroring it.
pub(crate) const SNAP_GRID: f64 = 1.0 / 65536.0;

#[inline]
fn snap(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

// The cross-operand near-coincidence weld lives in `super::plane_weld`: it was
// split out of this module when #3353 made it a boolean-wide concern rather
// than a subtraction-only one, and this module was at its size budget.
use super::plane_weld::{promote_cutter_verts_onto_host_faces, promote_operands_mutually};

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

/// `host − cutter` as a `Mesh`.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    #[cfg(feature = "csg_capture")]
    crate::csg_capture::record_single(host, cutter);
    let h = orient_outward(mesh_to_tris(host));
    let mut c = mesh_to_tris(cutter);
    promote_cutter_verts_onto_host_faces(&mut c, &h, false);
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
            promote_cutter_verts_onto_host_faces(&mut c, &h, false);
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
    union_with_conformity(a, b).0
}

/// Like [`union`], but also reports arrangement conformity (`unrecovered == 0`).
/// Diagnostics only (#3353); `union()` computes and discards this same signal.
pub fn union_with_conformity(a: &Mesh, b: &Mesh) -> (Mesh, bool) {
    // #1109 budget, as `subtract` does: fresh PER-BOOLEAN count, per-ELEMENT accumulator
    // intact — `begin()` resets only the per-op counter, so a union inside an over-budget
    // element STILL trips (see `budget::begin`). Without it a union after a tripped
    // subtract starts tripped and `arrange` bails at its first pair.
    super::budget::begin();
    // Reconcile the two operands' near-coplanar faces onto shared planes BEFORE
    // the arrangement (#3353). Mutual, not cutter-onto-host: union has no host,
    // and the one-directional form left `union_mesh(b, a)` tearing on the same
    // fixture `union_mesh(a, b)` handled. See `promote_operands_mutually`.
    let mut operands = [mesh_to_tris(a), mesh_to_tris(b)];
    promote_operands_mutually(&mut operands);
    let [ta, tb] = operands;
    let (a, b) = (orient_outward(ta), orient_outward(tb));
    let (out, conforming) = boolean_with_conformity(&a, &b, BoolOp::Union);
    // On a trip `out` is PARTIAL: discard it, return empty — the graceful fallback callers
    // handle (`csg::union_mesh` merges plainly; #960 goes sequential), never a poisoned
    // mesh. The trip point is a pure function of the snapped operands, so wasm agrees.
    if super::budget::tripped() {
        return (Mesh::new(), conforming);
    }
    (tris_to_mesh(&out), conforming)
}

#[path = "nary_union.rs"]
mod nary_union;
pub use nary_union::union_many;
pub(crate) use nary_union::{union_many_preserving_coordinates, union_many_reconciled};

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

#[cfg(test)]
#[path = "issue_3913_sweep_tests.rs"]
mod issue_3913_sweep_tests;
