// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-operand near-coincidence promotion, split out of `mesh_bridge.rs`
//! (which sits at its module-size budget) when #3353 made it a boolean-wide
//! concern rather than a subtraction-only one.
//!
//! `mesh_bridge` snaps each operand's coordinates to [`SNAP_GRID`]
//! INDEPENDENTLY, so two faces a user authored flush can land a few µm apart.
//! Everything downstream then has to guess whether they are one surface or
//! two, and the kernel's stages do not guess alike: `broadphase` says "not
//! touching" on exact AABBs, `tritri::near_coplanar` and `classify`'s regime 1
//! both say "flush" on a [`NearBand`]. This module removes the guess at the
//! source by MOVING the vertex onto the plane, which is why it belongs before
//! the arrangement rather than inside the classifier.

use super::arrangement::Tri;
use super::near_band::NearBand;

pub use diag::take_plane_weld_stats;

/// Weld telemetry (#3353): how often the promotion actually MOVES anything.
///
/// It exists because the #3353 fix landed with a byte-identical
/// `triangulation_invariance` golden, and "the golden did not move" has two
/// readings that matter very differently: the weld fires on real IFC and
/// changes nothing measurable, or it never fires on real IFC at all. Inferring
/// which from an unchanged number is the shape this repo keeps rediscovering,
/// so the count is measured instead. Same feature gating and relaxed-atomic
/// pattern as `router/voids/prism_cut.rs`'s prism stats.
#[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
mod diag {
    use std::sync::atomic::{AtomicU64, Ordering};

    // Two independent tallies, because they answer different questions and a
    // single one cannot be read. The low-level weld has been running on every
    // `subtract` since #1007; only the UNION tally is new in #3353, and only it
    // measures that change's blast radius. Summing them would let subtract's
    // long-standing traffic stand in for evidence about the new caller.
    static CALLS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static FIRED: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static VERTS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

    /// `CALLS[ALL]` etc.: every call to the low-level weld, whatever the caller.
    const ALL: usize = 0;
    /// `CALLS[UNION]` etc.: only calls made through the union's mutual
    /// promotion.
    const UNION: usize = 1;

    /// Record one low-level promotion call and the vertices it moved.
    #[inline]
    pub(super) fn record(welded: usize) {
        bump(ALL, welded);
    }

    /// Record one MUTUAL (union) promotion and the vertices it moved in total.
    #[inline]
    pub(super) fn record_union(welded: usize) {
        bump(UNION, welded);
    }

    #[inline]
    fn bump(slot: usize, welded: usize) {
        CALLS[slot].fetch_add(1, Ordering::Relaxed);
        if welded > 0 {
            FIRED[slot].fetch_add(1, Ordering::Relaxed);
        }
        VERTS[slot].fetch_add(welded as u64, Ordering::Relaxed);
    }

    /// Read + reset `[(calls, calls that moved something, vertices moved); 2]`
    /// as `[every caller, union only]`. Process-global relaxed atomics: a stale
    /// read under concurrency mis-reports a diagnostic count, never geometry.
    pub fn take_plane_weld_stats() -> [(u64, u64, u64); 2] {
        [ALL, UNION].map(|s| {
            (
                CALLS[s].swap(0, Ordering::Relaxed),
                FIRED[s].swap(0, Ordering::Relaxed),
                VERTS[s].swap(0, Ordering::Relaxed),
            )
        })
    }
}

#[cfg(not(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry")))]
mod diag {
    #[inline]
    pub(super) fn record(_welded: usize) {}
    #[inline]
    pub(super) fn record_union(_welded: usize) {}
    /// Telemetry disabled in the default build; a caller that wants real counts
    /// must enable `debug_geometry` (or another observability feature).
    pub fn take_plane_weld_stats() -> [(u64, u64, u64); 2] {
        [(0, 0, 0); 2]
    }
}

/// Mutually promote every operand onto the OTHERS' face planes — the union
/// form of [`promote_cutter_verts_onto_host_faces`].
///
/// # Why union needs both directions and subtract does not
///
/// Subtraction has a natural asymmetry: the host is the thing being cut and
/// must not move, so welding the CUTTER onto it is the whole answer. Union has
/// no such role split. `a ∪ b` and `b ∪ a` are the same solid, but a
/// one-directional weld is keyed to argument POSITION, and on #3353's pinned
/// fixture each direction fixed only its own caller order: welding B onto A
/// left `union_mesh(b, a)` with 8 unmatched directed edges, welding A onto B
/// left `union_mesh(a, b)` with 9. The reconciliation a pair needs is not
/// always in the direction the caller happened to write.
///
/// # Why one pass is not enough
///
/// A single pass in index order welds operand 0 onto the others FIRST, which
/// is the wrong direction for some pairs: pulling an axis-aligned operand's
/// corner onto a rotated operand's tilted plane reconciles that pair and
/// perturbs the mover's own faces at the same time. The following operands
/// then reconcile against the perturbed geometry. A SECOND pass lets the
/// earlier operands re-reconcile against what the later ones settled on, and
/// that is what closes the case one pass opens.
///
/// So passes run until one welds nothing, capped by [`MAX_WELD_PASSES`] — and
/// the cap is a TERMINATOR, not a safety margin. Over the 9464-union sweep in
/// `issue_3353_near_coplanar_rotated_overlap.rs` nothing exceeds two moving
/// passes, which is what an earlier version of this note generalised into "the
/// loop terminates on its own for every case measured". That was true of that
/// sweep and false of the operand space: re-running this function UNCAPPED
/// over 80,000 randomised near-coplanar box pairs (arbitrary rotation axis,
/// angle in ±90°, edges 0.3–3.0, Z offsets −6..+6 snap steps) left 40 pairs
/// moving the same vertex count on all 64 passes and still going, with 8 more
/// converging only after 5 to 13 moving passes. The oscillation this cap was
/// written to bound — a vertex alternating between two planes equidistant
/// within the band — is REAL and reachable, so removing the cap in favour of
/// iterating to `moved == 0` hangs. `the_weld_pass_cap_is_load_bearing_because_the_weld_can_oscillate`
/// pins one of those pairs and hangs if the cap is removed.
///
/// Returning after four passes therefore hands `boolean_with_conformity`
/// operands that are only partly reconciled in those cases. That is the
/// deliberate trade: a bounded, deterministic partial reconciliation, whose
/// output `union_pair` still validates and can fall back on, in exchange for
/// termination.
///
/// # What this does and does not make commutative
///
/// NOT the coordinates: `a ∪ b` may reconcile onto `a`'s plane where `b ∪ a`
/// reconciles onto `b`'s, one snap step away. What it makes commutative is the
/// property that matters — both orders come back CLOSED, with the same volume
/// to within a snap step's worth of surface. That is what
/// `issue_3353_near_coplanar_rotated_overlap.rs` asserts, in both orders.
///
/// Returns the number of vertices moved, in total, across every pass.
///
/// DETERMINISM: fixed index order, fixed pass order, and each step is the same
/// FMA-free f64 [`promote_cutter_verts_onto_host_faces`] ⇒ byte-identical
/// native == wasm.
pub(crate) fn promote_operands_mutually(operands: &mut [Vec<Tri>]) -> usize {
    let n = operands.len();
    if n < 2 {
        return 0;
    }
    let mut welded = 0usize;
    let mut host: Vec<Tri> = Vec::new();
    for _pass in 0..MAX_WELD_PASSES {
        let mut moved = 0usize;
        for i in 0..n {
            host.clear();
            for (j, o) in operands.iter().enumerate() {
                if j != i {
                    host.extend_from_slice(o);
                }
            }
            moved += promote_cutter_verts_onto_host_faces(&mut operands[i], &host);
        }
        welded += moved;
        if moved == 0 {
            break;
        }
    }
    diag::record_union(welded);
    welded
}

/// Pass cap for [`promote_operands_mutually`], and the only thing that makes it
/// terminate: an uncapped weld does not converge on every input (see that
/// function's "Why one pass is not enough"). Four covers every pair in the
/// pinned sweep, which never exceeds two moving passes; raising it only moves
/// where the non-convergent minority is truncated, and removing it hangs.
const MAX_WELD_PASSES: usize = 4;

/// Cross-operand near-coincidence promotion: weld every CUTTER vertex that
/// sits within the snap-scatter band of a HOST face PLANE onto that plane.
///
/// The gate is the plane, not the face's footprint — see "The gate is
/// PLANE-level" below, which is the whole reason this works on the repro. An
/// earlier version of this line said the vertex must also project strictly
/// inside the face; it does not, and never did in this code.
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
/// by face index ⇒ byte-identical native==wasm.
///
/// The "every pinned box−box manifest is transversal, so the promotion never
/// fires there" claim this note used to carry is scoped to SUBTRACT, where it
/// was measured. It does not hold for the union caller added in #3353: the
/// whole point there is a near-coplanar operand pair, and the weld fires on
/// every one of the 9464 unions in
/// `tests/issue_3353_near_coplanar_rotated_overlap.rs`.
/// Returns the number of vertices actually MOVED, so callers (and the #3353
/// census run) can measure whether the promotion fires at all rather than
/// inferring it from an unchanged golden.
pub(crate) fn promote_cutter_verts_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) -> usize {
    if cutter.is_empty() || host.is_empty() {
        return 0;
    }
    let mut welded = 0usize;
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
                    if w != *v {
                        welded += 1;
                    }
                    *v = w;
                }
            }
        }
    }
    diag::record(welded);
    welded
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
