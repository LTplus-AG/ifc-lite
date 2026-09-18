// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic count bounds for B-spline / NURBS curve and surface
//! evaluation (issue #4901, a follow-up to the #4884/#4888 hung-geometry-call
//! recovery).
//!
//! `IfcBSplineCurveWithKnots` / `IfcBSplineSurfaceWithKnots` carry `Degree`
//! and a `ControlPointsList` straight from the file with no schema-level
//! ceiling. The Cox-de Boor basis-function recursion is exponential in the
//! degree when it is not memoized (`T(p) = 2*T(p-1) + O(1)` ⇒ `O(2^p)` calls
//! per basis function per sample point): a file-supplied `Degree` of a few
//! hundred never finishes, and unlike the CSG kernel's exact-predicate work
//! (`kernel::budget`) this recursion was NOT memoized at all, so it is not
//! merely slow but genuinely non-terminating in practice.
//!
//! Two independent, deterministic (not wall-clock) bounds close this:
//!
//! - [`bspline::bspline_basis_table`] replaces the naive per-index recursive
//!   calls with a single bottom-up (memoized) table build per sample point:
//!   the SAME recurrence, each `(level, index)` cell computed once instead of
//!   exponentially many times. This is a pure performance fix — the value of
//!   every cell is a pure function of its inputs, so memoizing cannot change
//!   the result — and turns `O(2^p)` into `O(p * (n + p))`.
//! - [`MAX_BSPLINE_DEGREE`] then bounds `p` itself, so the now-polynomial cost
//!   stays polynomial in a small constant rather than in an attacker-chosen
//!   number. `bspline_basis_table` clamps internally (defense in depth: every
//!   caller is protected, not just the ones that check first), and the
//!   surface entry point ([`crate::processors::advanced_face::surfaces::process_bspline_face`])
//!   additionally rejects a too-high degree explicitly, so the failure is
//!   reported (`GeometryRouter::record_unsupported_item`) instead of silently
//!   clamped to a different (wrong) surface.
//!
//! [`MAX_BSPLINE_SURFACE_CONTROL_POINTS`] bounds the OTHER unbounded input:
//! `evaluate_bspline_surface`'s weighted sum is `O(n_u * n_v)` per sample
//! point (it does not exploit local support — nonzero basis functions are
//! only ever `degree + 1` wide per axis — because doing so would reorder the
//! floating-point sum and perturb pinned mesh output; that stays a follow-up,
//! not #4901's scope). A 64x64 grid (4096 control points) is already an
//! unusually dense authored NURBS patch — real architectural facade / roof
//! panels in the corpus run to a few hundred at most — so this cap is
//! generous headroom, not a legitimate-input ceiling.
//!
//! Calibration: `MAX_BSPLINE_DEGREE = 64` is ~5x the "practical NURBS" degree
//! ceiling of ~12 already documented next to `MAX_KNOT_MULTIPLICITY` in
//! `bspline.rs`, while `64 * (4096 + 64)` (surface table-build worst case per
//! sample point) and `64 * 4096` (surface weighted-sum worst case per sample
//! point) both stay under ten million elementary float ops even at the
//! densest legal tessellation (`profile_arc_segments` / `scale_segments` cap
//! sample counts at a few thousand per surface) — comfortably sub-second, and
//! IDENTICAL on native and wasm because every bound is a count, never a
//! timer.

/// Hard ceiling on `IfcBSplineCurveWithKnots.Degree` /
/// `IfcBSplineSurfaceWithKnots.{U,V}Degree`. See the module doc for the
/// derivation; any real-world NURBS in the model corpus sits under ~12.
pub(super) const MAX_BSPLINE_DEGREE: usize = 64;

/// Hard ceiling on the total `ControlPointsList` size (`n_u * n_v`) of an
/// `IfcBSplineSurfaceWithKnots`. See the module doc.
pub(super) const MAX_BSPLINE_SURFACE_CONTROL_POINTS: usize = 4096;

/// Hard ceiling on an `IfcBSplineCurveWithKnots.ControlPointsList` length.
/// Curves are 1-D (no `n_u * n_v` blow-up), so this exists only to keep the
/// per-sample table build (`O(degree * (n + degree))`) from scaling with an
/// attacker-chosen point count; real edge/profile curves run to low hundreds.
pub(super) const MAX_BSPLINE_CURVE_CONTROL_POINTS: usize = 8192;
