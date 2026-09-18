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
//! [`MAX_BSPLINE_SURFACE_SAMPLE_WORK`] bounds the OTHER unbounded input:
//! `evaluate_bspline_surface`'s weighted sum is `O(n_u * n_v)` per sample
//! point (it does not exploit local support — nonzero basis functions are
//! only ever `degree + 1` wide per axis — because doing so would reorder the
//! floating-point sum and perturb pinned mesh output; that stays a follow-up,
//! not #4901's scope), so the real cost driver is `samples * n_u * n_v`, not
//! `n_u * n_v` alone. A flat control-point-count ceiling was tried first and
//! calibrated against "a few hundred is already dense" — wrong: the in-tree
//! `tests/models/issues/472_2222.ifc` fixture (issue #472) carries a real
//! 207x180 (37,260-point) patch, well past any such guess, and a flat cap
//! rejected it, changing legitimate output (caught by
//! `geometry_correctness_harness`'s pinned snapshot). Sample count is already
//! capped by `scale_segments` (`process_bspline_face`'s `u_segments` /
//! `v_segments`, ~25-97 per axis), so `MAX_BSPLINE_SURFACE_SAMPLE_WORK` bounds
//! the PRODUCT instead: `(u_segments+1) * (v_segments+1) * n_u * n_v`. The
//! #472 fixture's worst surface measures 625 * 37,260 ≈ 23.3M — this cap
//! gives it over 20x headroom while still bailing well before a genuinely
//! adversarial grid (millions of control points) could cost more than a
//! fraction of a second.
//!
//! Calibration: `MAX_BSPLINE_DEGREE = 64` is ~5x the "practical NURBS" degree
//! ceiling of ~12 already documented next to `MAX_KNOT_MULTIPLICITY` in
//! `bspline.rs`. `MAX_BSPLINE_SURFACE_SAMPLE_WORK`'s 500M simple float
//! multiply-adds run in well under a second; both bounds are counts, never
//! timers, so native and wasm reject the same file identically.

/// Hard ceiling on `IfcBSplineCurveWithKnots.Degree` /
/// `IfcBSplineSurfaceWithKnots.{U,V}Degree`. See the module doc for the
/// derivation; any real-world NURBS in the model corpus sits under ~12.
pub(super) const MAX_BSPLINE_DEGREE: usize = 64;

/// Hard ceiling on `(u_segments+1) * (v_segments+1) * n_u * n_v` — the total
/// number of weighted-sum terms `tessellate_bspline_surface` will evaluate
/// across the whole surface. See the module doc for why this bounds the
/// actual cost driver where a flat control-point-count cap does not (and, in
/// an earlier version of this bound, actively regressed a real fixture).
pub(super) const MAX_BSPLINE_SURFACE_SAMPLE_WORK: u64 = 500_000_000;

/// Hard ceiling on an `IfcBSplineCurveWithKnots.ControlPointsList` length.
/// Curves are 1-D (no `n_u * n_v` blow-up), so this exists only to keep the
/// per-sample table build (`O(degree * (n + degree))`) from scaling with an
/// attacker-chosen point count; real edge/profile curves run to low hundreds.
pub(super) const MAX_BSPLINE_CURVE_CONTROL_POINTS: usize = 8192;
