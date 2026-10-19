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
//! both say "flush" on a [`super::near_band::NearBand`]. This module removes the guess at the
//! source by MOVING the vertex onto the plane, which is why it belongs before
//! the arrangement rather than inside the classifier. Supporting planes remain
//! eligible outside their face footprints. An already admitted noncorner lift
//! may prefer a covering face on a distinct plane; exact corners and same-plane
//! seam identities retain their original targets. Every proposed move preserves
//! originally exact source/host faces with positive-area overlap (#7292).

use super::arrangement::Tri;
use super::near_band::NearBand;

mod lift;
mod axis_rescue;

mod incidence;
mod source_axes;
mod transversal;
mod contact_stability;
mod selection;
mod promotion;
mod separate_incidence;

pub use diag::take_plane_weld_stats;

/// Weld telemetry (#3353): how often the promotion actually MOVES anything.
///
/// It exists because the #3353 fix landed with a byte-identical
/// `triangulation_invariance` golden, and "the golden did not move" reads two
/// very different ways: the weld fires on real IFC and changes nothing
/// measurable, or it never fires at all. Inferring which from an unchanged
/// number is the shape this repo keeps rediscovering, so the count is measured.
/// Same gating and relaxed-atomic pattern as `router/voids/prism_cut.rs`.
#[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
mod diag {
    use std::sync::atomic::{AtomicU64, Ordering};

    // Two tallies, because a single one cannot be read: the low-level weld has
    // run on every `subtract` since #1007, so subtract's long-standing traffic
    // would stand in for evidence about the UNION caller that is new in #3353.
    // They NEST rather than partition — a mutual promotion bumps UNION once and
    // ALL once per low-level call inside it, welded vertices counted in both —
    // so `ALL - UNION` is NOT subtract's share.
    static CALLS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static FIRED: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static VERTS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

    /// `CALLS[ALL]` etc.: every call to the low-level weld, whatever the caller.
    pub(super) const ALL: usize = 0;
    /// `CALLS[UNION]` etc.: only the union's mutual promotions.
    pub(super) const UNION: usize = 1;

    /// Record one promotion call into `slot`, and the vertices it moved.
    #[inline]
    pub(super) fn record(slot: usize, welded: usize) {
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
    pub(super) const ALL: usize = 0;
    pub(super) const UNION: usize = 1;
    #[inline]
    pub(super) fn record(_slot: usize, _welded: usize) {}
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
/// Only PARTLY, and the limit is invisible from here: [`lift::exact_on_plane_weld`]
/// emits the moved vertex on the 2⁻³⁶ grid while its host gate refuses any
/// triangle off the 2⁻¹⁶ operand grid, so a just-welded triangle is silently
/// REFUSED as a host for the rest of the call. The reverse direction and every
/// later pass reconcile only against faces that did NOT move. That is why this
/// works at all (most faces do not move) and why it is less than the full
/// both-directions reconciliation the name suggests. Lifting it moves welded
/// coordinates, hence the determinism manifests: its own change.
///
/// So passes run until one welds nothing, capped by [`MAX_WELD_PASSES`] — a
/// TERMINATOR, not a safety margin: the weld does NOT reach a fixed point on
/// every input, so iterating to `moved == 0` HANGS. The 80,000-pair hunt and
/// the non-convergent pair it found are recorded on
/// `the_weld_pass_cap_is_load_bearing_because_the_weld_can_oscillate` in
/// `issue_3353_near_coplanar_rotated_overlap.rs`, which pins the cap. Capped
/// cases reach `boolean_with_conformity` only partly reconciled (an output
/// `union_pair` still validates and can fall back on) in exchange for
/// terminating at all.
///
/// # What this does and does not make commutative
///
/// NOT the coordinates: `a ∪ b` may reconcile onto `a`'s plane where `b ∪ a`
/// reconciles onto `b`'s, one snap step away. What it makes commutative is the
/// property that matters — both orders come back CLOSED, with the same volume
/// to within a snap step's worth of surface. That is what
/// `issue_3353_near_coplanar_rotated_overlap.rs` asserts, in both orders.
///
/// # Cost, and the pruning this does NOT do
///
/// A pass is `O(6 · tris_a · tris_b)` plane evaluations, no broadphase in front
/// of it. Union wall time, weld vs the same build with the call removed, on
/// DISJOINT boxes where it cannot move anything: 768 tris each 2.8 → 8.3 ms,
/// 4800 each 39.7 → 571. Quadratic, and blind to whether the operands touch.
/// Deliberate: a per-face AABB reject contradicts the gate being PLANE-level
/// (see [`promote_cutter_verts_onto_host_faces`]), and a whole-operand one is
/// not a no-op either, a plane being infinite. The lever that would work,
/// keying host faces by PLANE, moves which triangle supplies
/// [`lift::exact_on_plane_weld`]'s edge basis — hence welded coordinates, hence the
/// determinism manifests: its own change. Exposure is NOT as narrow as the
/// census (zero unions on AC20-FZK-Haus, ISSUE_129, ISSUE_053, FM_ARC_DigitalHub)
/// suggests: besides an explicit `.UNION.` IfcBooleanResult, `build_cutter_union`
/// falls back to `csg::union_meshes` when `union_many` returns empty, folding
/// pairwise through `union_pair` → `union` and paying this quadratic weld
/// against a GROWING accumulator each step — triggered by a budget trip, so on
/// models already heavy. The weld also sits OUTSIDE the #1109 budget bounding
/// every other kernel stage; wiring it in is deferred, not judged unnecessary.
///
/// Vertices moved go to [`take_plane_weld_stats`]'s union tally, its only
/// reader. No return value: a partly-reconciled pair is still a valid
/// `boolean_with_conformity` input, so no caller would branch on the count.
///
/// DETERMINISM: fixed index order and pass order, FMA-free f64 arithmetic and
/// exact predicates in [`promote_cutter_verts_onto_host_faces`] ⇒ native == wasm.
pub(crate) fn promote_operands_mutually(operands: &mut [Vec<Tri>]) {
    let n = operands.len();
    let mut welded = 0usize;
    if n < 2 {
        diag::record(diag::UNION, welded); // a call with nothing to do is still a call
        return;
    }
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
    diag::record(diag::UNION, welded);
}

/// Pass cap for [`promote_operands_mutually`] and the only thing that makes it
/// terminate: an uncapped weld does NOT converge on every input (see there).
///
/// The VALUE 4 is headroom, not a convergence bound. The pinned sweep never
/// needs more than 2 moving passes and the stragglers need 5 to 13, which no
/// cap serves without also admitting the pairs that never converge; the two
/// spare passes cover operands the sweep does not, and claim nothing further.
const MAX_WELD_PASSES: usize = 4;

/// Cross-operand near-coincidence promotion: weld every CUTTER vertex that
/// sits within the snap-scatter band of a HOST face PLANE onto that plane.
///
/// Eligibility uses the supporting plane, including outside its footprint.
/// For an already admitted noncorner Q20 lift, selection may prefer the nearest
/// eligible covering face on a distinct plane. A containing same-plane sibling
/// retains the original edge basis. Refused lifts and existing host-corner
/// targets keep their established path (#7292).
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
/// `near_on_surface_normal`: [`super::near_band::NearBand`], sized PER HOST PLANE from the
/// operands' per-axis extents projected onto that plane's own normal
/// (8·SNAP_GRID until the projected extent passes ~512 CALLER units, not metres
/// (#2684), so an offset along an axis this plane does not face never widens it).
/// DETERMINISM: FMA-free f64 distance/drift arithmetic and exact projection/
/// plane predicates over already-snapped coordinates, fixed iteration order,
/// face-order ties ⇒ byte-identical native==wasm.
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
    promotion::promote::<false>(cutter, host)
}

/// Opening-only form: additionally retain separate coincident host surfaces (#6940).
/// Ordinary public subtraction and mutual promotion retain main's #7292 behavior.
pub(crate) fn promote_subtract_cutter_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) -> usize {
    promotion::promote::<true>(cutter, host)
}

#[cfg(test)]
mod tests;
