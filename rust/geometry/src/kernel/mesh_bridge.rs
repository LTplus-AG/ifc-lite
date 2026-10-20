// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices). `subtract`/`union`/
//! `intersection` here are what the `ClippingProcessor` seam calls.

use super::arrangement::{
    boolean, boolean_with_conformity, difference_all, difference_all_lenient,
    difference_all_lenient_with_conformity, BoolOp,
    Tri,
};
use super::signed_volume::signed_volume6;
use crate::mesh::Mesh;
#[path = "mesh_bridge/batch_oracle.rs"]
mod batch_oracle;
use batch_oracle::validate_lenient_batch;

mod batch_subtract;
pub use batch_subtract::BatchSubtract;

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
use super::plane_weld::{
    promote_cutter_verts_onto_host_faces, promote_operands_mutually,
    promote_subtract_cutter_onto_host_faces,
};

/// `Mesh` → the kernel's triangle list (f32 → f64, snapped to the reconcile
/// grid). Panic-free: an out-of-range index OR a non-finite (NaN/Inf) coord drops
/// that triangle rather than indexing past the end or crashing
/// `BigRational::from_float` deep in the predicates (the two empirically-found
/// reachable panic sites).
pub fn mesh_to_tris(m: &Mesh) -> Vec<Tri> {
    let vertex = |i: u32| -> Option<[f64; 3]> {
        // Checked: a wasm32 index past 2^32/3 must drop, not wrap (#7688).
        let b = (i as usize).checked_mul(3)?;
        let p = m.positions.get(b..b.checked_add(3)?)?;
        let c = [p[0] as f64, p[1] as f64, p[2] as f64];
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

/// The triangle's supporting plane in f64: unit normal + offset (`n . v0`),
/// BEFORE any f32 cast. `(0,0,1,0)`-ish degenerate fallback for a
/// zero-area triangle, matching `face_normal`'s old `[0,0,1]` default.
fn face_plane(t: &Tri) -> ([f64; 3], f64) {
    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 {
        let n = [n[0] / len, n[1] / len, n[2] / len];
        let d = n[0] * t[0][0] + n[1] * t[0][1] + n[2] * t[0][2];
        (n, d)
    } else {
        ([0.0, 0.0, 1.0], t[0][2])
    }
}

/// The kernel's triangle list → a `Mesh` (per-face flat normals, f64 → f32).
///
/// Also tags every output triangle with its f64 supporting plane
/// ([`PlaneTag`], issue #3914) — the exact plane this function's own f64
/// arithmetic derived, before the `positions`/`normals` f32 cast below loses
/// precision. Union output carries the tags through this entry point;
/// difference/intersection output uses [`tris_to_mesh_without_plane_tags`]
/// because its consolidated result can become another boolean operand (#5012).
pub fn tris_to_mesh(tris: &[Tri]) -> Mesh {
    tris_to_mesh_impl(tris, true)
}

fn tris_to_mesh_without_plane_tags(tris: &[Tri]) -> Mesh {
    tris_to_mesh_impl(tris, false)
}

fn tris_to_mesh_impl(tris: &[Tri], carry_plane_tags: bool) -> Mesh {
    use crate::mesh::PlaneTag;
    let mut m = Mesh::with_capacity(tris.len() * 3, tris.len() * 3);
    let mut tags = Vec::with_capacity(tris.len());
    for t in tris {
        let (n64, d64) = face_plane(t);
        let n = [n64[0] as f32, n64[1] as f32, n64[2] as f32];
        let base = (m.positions.len() / 3) as u32;
        for p in t {
            m.positions
                .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            m.normals.extend_from_slice(&n);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        tags.push(PlaneTag { n: n64, d: d64 });
    }
    if carry_plane_tags {
        m.plane_tags = Some(tags);
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

/// `host − cutter` as a `Mesh`, retaining the general operand weld.
/// Opening-specific welding is selected internally by the void router.
///
/// Owns its #1109 budget like [`union`] (#7688 KERNEL-17): a fresh count, so
/// a stale one cannot truncate it, and EMPTY on a trip, never the partial
/// arrangement. Inside a spent element it trips at once.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    super::budget::begin();
    let (out, _, _) = subtract_with_change(host, cutter, false);
    if super::budget::tripped() {
        return Mesh::new();
    }
    out
}

/// Like [`subtract`], but also returns the classifier's `changed` bit (#4692).
/// Caller-managed budget: the caller calls `budget::begin()` first and
/// discards the result when `budget::tripped()` (`csg::subtract_mesh`).
///
/// `false` means no host sub-triangle was dropped and no cutter face was kept,
/// so the triangles are the host re-tessellated, not a cut. [`subtract_many`]
/// reads the same bit.
///
/// A one-component [`difference_all_lenient`] is the binary
/// `boolean(.., Difference)`: the same arrangement over the same operands,
/// classified through the same one-component `BComponents`, and neither gates
/// on conformity. The third element says whether the arrangement conformed.
///
/// `opening` picks the weld: an opening cutter takes the guarded subtract weld
/// (#6940), an `IfcBooleanResult` operand the plain one, as before #6940.
pub(crate) fn subtract_with_change(host: &Mesh, cutter: &Mesh, opening: bool) -> (Mesh, bool, bool) {
    #[cfg(feature = "csg_capture")]
    crate::csg_capture::record_single(host, cutter, opening);
    if super::budget::tripped() { return (Mesh::new(), false, false); }
    let h = orient_outward(mesh_to_tris(host));
    let mut c = mesh_to_tris(cutter);
    let weld = if opening { promote_subtract_cutter_onto_host_faces } else { promote_cutter_verts_onto_host_faces };
    weld(&mut c, &h);
    if super::budget::tripped() { return (Mesh::new(), false, false); }
    let c = orient_outward(c);
    let (tris, changed, conforming) = difference_all_lenient_with_conformity(&h, &[&c]);
    (tris_to_mesh_without_plane_tags(&tris), changed, conforming)
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
/// See [`BatchSubtract`] for the three outcomes.
///
/// Owns its #1109 budget like [`subtract`]: a trip is `Nonconforming`, the
/// outcome callers already fall back from, never a truncated `Cut` or a
/// false `Unchanged` (#7688 KERNEL-17).
pub fn subtract_many(host: &Mesh, cutters: &[&Mesh]) -> BatchSubtract {
    super::budget::begin();
    let (out, _, _) = subtract_many_with_conformity(host, cutters, false, false);
    if super::budget::tripped() {
        return BatchSubtract::Nonconforming;
    }
    out
}

/// Keep the provenance of an unchanged batch for the void router (#6516).
/// A volume-checked nonconforming miss must retain the sequential fallback.
/// Caller-managed budget, as [`subtract_with_change`] (`csg::group_cut`).
pub(crate) fn subtract_many_with_conformity(
    host: &Mesh, cutters: &[&Mesh], opening: bool, retain_conforming_miss: bool,
) -> (BatchSubtract, bool, Option<Mesh>) {
    #[cfg(feature = "csg_capture")]
    crate::csg_capture::record_many(host, cutters, opening, retain_conforming_miss);
    if super::budget::tripped() { return (BatchSubtract::Nonconforming, false, None); }
    let h = orient_outward(mesh_to_tris(host));
    let mut comp_tris: Vec<Vec<Tri>> = Vec::with_capacity(cutters.len());
    for m in cutters {
        let mut c = mesh_to_tris(m);
        if opening {
            promote_subtract_cutter_onto_host_faces(&mut c, &h);
        } else {
            promote_cutter_verts_onto_host_faces(&mut c, &h);
        }
        if super::budget::tripped() { return (BatchSubtract::Nonconforming, false, None); }
        comp_tris.push(orient_outward(c));
    }
    let refs: Vec<&[Tri]> = comp_tris.iter().map(|c| c.as_slice()).collect();
    // Conforming batch: the fast, exact, byte-identical common path.
    if let Some((r, changed)) = difference_all(&h, &refs) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.batch_conforming_arrangements = c.batch_conforming_arrangements.saturating_add(1);
            c.batch_conforming_misses = c.batch_conforming_misses.saturating_add(u64::from(!changed));
        });
        // Only the private void-group caller requests this: an unchanged
        // arrangement still carries useful seams for topology consolidation.
        let miss = (retain_conforming_miss && !changed)
            .then(|| tris_to_mesh_without_plane_tags(&r));
        return (BatchSubtract::classified(&r, changed), true, miss);
    }
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::record(|c| c.batch_nonconforming_arrangements = c.batch_nonconforming_arrangements.saturating_add(1));
    // Non-conforming batch (an unrecovered constraint remains after the robust
    // traversal recovery). Its exact topology is CLEANER than sequential per-cutter
    // re-jitter on dense faceted-reveal walls (issue #098 V5C: 532→108 open edges),
    // but a straddling misclassification can over/under-cut VOLUME (#559171/#1167).
    // Trust the lenient batch ONLY when its removed volume matches the true removed
    // volume; else Nonconforming, so the caller runs its full sequential path.
    let (batch, changed) = difference_all_lenient(&h, &refs);
    validate_lenient_batch(&h, &comp_tris, &batch, changed)
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
pub(crate) use nary_union::union_many_preserving_coordinates;

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
    tris_to_mesh_without_plane_tags(&intersection_tris(a, b))
}

#[cfg(test)]
#[path = "mesh_bridge_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "issue_3913_sweep_tests.rs"]
mod issue_3913_sweep_tests;
