// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Normal-projected near-coplanar band for the exact kernel.
//!
//! Extracted from `kernel/mesh_bridge.rs` so the band-sizing concern lives in
//! one place, exactly as `csg/plane_eps.rs` (#2598) extracted the clipper's
//! plane epsilon. Deliberately the SAME formulation as that module and as its
//! TypeScript siblings — `epsForPlane` in
//! `packages/clash/src/contact/tri-tri.ts` (#2661) and the LOCAL-coordinate
//! tolerance sizing in `packages/drawing-2d/src/section-cutter.ts` (#2622) —
//! not a fourth one.
//!
//! # What was wrong with the scalar band
//!
//! [`near_band_from_extent`] takes ONE scalar `extent`, the max |coordinate|
//! over ALL THREE axes of both operands, and returns
//! `max(8*SNAP_GRID, extent * 2^-22)`. Its consumers then compare that band
//! against a PERPENDICULAR distance to a specific plane. A signed plane
//! distance is `dot(v - p, n)`, so each coordinate's f32 rounding noise enters
//! it weighted by that axis's normal component: an axis orthogonal to `n`
//! contributes nothing however far it puts the model from the origin.
//!
//! Collapsing the three axes to their max therefore sizes the band from an
//! axis the plane never sees. A model 10 km out in X, cut by a Z-normal
//! plane, got `band = 1e4 * 2^-22 ~= 2.4 mm` from the irrelevant X magnitude
//! where the real f32 rounding step in Z is ~1.2e-4 m (the `8*SNAP_GRID`
//! floor). Two surfaces a genuine 2 mm apart then fell inside the band, were
//! reconciled as flush, and a 2 mm recess VANISHED — the same thin-flush-cut
//! collapse #2598 described for the clipper, live in the kernel's shared band
//! (`csg/world_frame_tests.rs::a_2mm_recess_cuts_identically_10km_out_in_x`,
//! far volume 0.3000030517580399 vs expected 0.29968).
//!
//! [`NearBand`] keeps the extent PER AXIS and projects it onto the plane's own
//! normal instead.
//!
//! # Determinism
//!
//! Plain FMA-free f64 (abs/mul/add/max) over already-snapped input
//! coordinates, fixed iteration order, no square root anywhere — the
//! comparison is made in the scaled `|n|`-weighted space precisely so no
//! normalisation is needed. Byte-identical native == wasm, like every other
//! predicate in this kernel.

use super::arrangement::Tri;
use super::mesh_bridge::SNAP_GRID;

/// f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
/// value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
/// larger magnitudes the ULP only grows. Same `2^-22` term (and reasoning) as
/// `F32_ULP_SCALE` in `csg/plane_eps.rs` and in
/// `packages/clash/src/contact/narrow-phase.ts`.
const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0;

/// The band's floor: the per-axis-snap scatter envelope near the origin, for
/// two operands, with margin (~122 µm). Unchanged from the scalar formula and
/// deliberately NOT projected: it is a tuned absolute allowance for
/// [`SNAP_GRID`] quantization, not a coordinate-magnitude term, and tightening
/// it is a tolerance change needing its own corpus evidence. Same split as
/// `csg/plane_eps.rs`, which also projects only the magnitude term.
pub(crate) const NEAR_BAND_FLOOR: f64 = 8.0 * SNAP_GRID;

/// The near-coplanar band as PER-AXIS coordinate extents, resolved against a
/// plane's own normal by [`NearBand::scaled_band2`].
///
/// Build it over exactly the coordinates whose f32 quantization can move the
/// distance being tested (both operands, plus the probe point where there is
/// one), then ask it per plane.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NearBand {
    /// Max |coordinate| per axis, in metres.
    axis_extent: [f64; 3],
}

impl NearBand {
    /// Fold one point's coordinates into the per-axis extents.
    pub(crate) fn observe_point(&mut self, p: &[f64; 3]) {
        for k in 0..3 {
            let a = p[k].abs();
            if a > self.axis_extent[k] {
                self.axis_extent[k] = a;
            }
        }
    }

    /// Fold every vertex of `tris` into the per-axis extents.
    pub(crate) fn observe_tris(&mut self, tris: &[Tri]) {
        for t in tris {
            for v in t {
                self.observe_point(v);
            }
        }
    }

    /// The band over `tris`.
    pub(crate) fn from_tris(tris: &[Tri]) -> Self {
        let mut band = Self::default();
        band.observe_tris(tris);
        band
    }

    /// Squared tolerance for the SCALED signed distance
    /// `d = dot(v - t0, n)`, where `n` is the plane's RAW (unnormalised)
    /// normal and `nn = |n|^2`:
    ///
    /// ```text
    /// scaled_band2(n) = max(FLOOR^2 * nn, (sum_i |n_i| * extent_i * 2^-22)^2)
    /// ```
    ///
    /// # Why the comparison happens in the scaled space
    ///
    /// The true test is `|d| / |n| <= max(FLOOR, sum_i |n_i|/|n| * noise_i)`.
    /// Multiplying both sides by `|n|` clears every division AND the square
    /// root: `|d| <= max(FLOOR * |n|, sum_i |n_i| * noise_i)`, which squares
    /// to the expression above (both sides are non-negative, so the max
    /// commutes with squaring). Callers therefore compare their raw `d * d`
    /// against this directly and never normalise a normal.
    ///
    /// This is the same reasoning as the "why there is no division by `|n|`"
    /// note on `PlaneEps::for_normal` in `csg/plane_eps.rs`: the tolerance must
    /// carry exactly the same `|n|` factor the distance it is compared against
    /// carries.
    ///
    /// # Relation to the scalar band: up to sqrt(3) LOOSER, not uniformly
    /// tighter
    ///
    /// For a unit normal `sum_i |n_i| * M_i <= sqrt(3) * max_i M_i`, with
    /// equality for a body-diagonal normal on an axis-symmetric operand — so a
    /// diagonal normal measures exactly `sqrt(3)` looser than the max-over-axes
    /// form above the floor crossover. That is the correct worst case when all
    /// three axes' rounding errors align; the projection is a restriction of
    /// WHICH axes may widen the band, not a uniform tightening.
    pub(crate) fn scaled_band2(&self, n: [f64; 3], nn: f64) -> f64 {
        let projected = (n[0].abs() * self.axis_extent[0]
            + n[1].abs() * self.axis_extent[1]
            + n[2].abs() * self.axis_extent[2])
            * F32_ULP_SCALE;
        (projected * projected).max(NEAR_BAND_FLOOR * NEAR_BAND_FLOOR * nn)
    }

    /// An isotropic UPPER bound on [`Self::scaled_band2`]'s unnormalised band
    /// over every possible plane normal, for the prefilters (BVH query radii,
    /// AABB pads) that must be a conservative superset rather than a decision.
    ///
    /// Every unit normal has `|n_i| <= 1`, so `sum_i |n_i| * noise_i <=
    /// sum_i noise_i`. Note it is the SUM and not the max: the max-over-axes
    /// scalar is NOT an upper bound on the projected band (see the sqrt(3)
    /// note above), so a prefilter sized by it could drop a candidate the
    /// per-plane test would have accepted.
    pub(crate) fn radius(&self) -> f64 {
        let sum = (self.axis_extent[0] + self.axis_extent[1] + self.axis_extent[2]) * F32_ULP_SCALE;
        sum.max(NEAR_BAND_FLOOR)
    }
}

/// The legacy SCALAR near-coplanar band: `max(8*SNAP_GRID, extent * 2^-22)`
/// from a single max-over-axes `extent`.
///
/// Retained ONLY for consumers that are not testing a distance along a plane
/// normal, where the collapse to a scalar is therefore not the defect
/// described in this module's header:
///
/// - `kernel/arrangement/classify.rs` (`BComponents::new`) pads an AABB in
///   every axis. An isotropic pad is what an axis-aligned box wants, and it is
///   sized from `operand_extent` (`2 * hi + 1`) with a further 4x factor, so it
///   stays a comfortable superset of every projected band inside it.
/// - `clash_solid.rs` gates the trust threshold for `intersection_solid`. That
///   caller IS in the defect class (its own known-failing corpus case,
///   `clash_solid_world_frame_tests.rs::a_5mm_overlap_10km_out_in_x_must_still_be_a_solid`,
///   pins it) but it measures a mesh THICKNESS, not a plane distance, so its
///   fix is a different change with its own evidence and is deliberately not
///   folded in here.
pub(crate) fn near_band_from_extent(extent: f64) -> f64 {
    NEAR_BAND_FLOOR.max(extent * F32_ULP_SCALE)
}
