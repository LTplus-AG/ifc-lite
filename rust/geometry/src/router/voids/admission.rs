// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whether a cutter is worth cutting with, whether it swallows the host, and
//! whether a cut is worth keeping (ROUTER-10).
//!
//! The batch, sequential, coaxial-union and prism paths used to paste these
//! guards in-line, each with its own operand precision: the sequential path
//! reads the f32 bounds in f32, the batch and fallback paths widen to f64. The
//! precisions are part of the pinned output, so the guards are generic over
//! [`Scalar`] and every caller keeps the one it always had; only the arithmetic
//! has one home.

use crate::mesh_check::{signed_volume_about, volume_reference};
use crate::{Mesh, Point3, TessellationQuality};
use std::ops::{Add, Mul, Sub};

/// Minimum opening volume (m³) below which CSG is skipped (degenerate-void filter).
/// 0.0001 m³ ≈ 0.1 litre — filters artefacts while allowing small real openings (e.g. sleeves).
pub(super) const MIN_OPENING_VOLUME: f64 = 0.0001;
/// Fraction of pre-CSG triangles the result must retain. CSG outputs with fewer
/// triangles than `pre_count / CSG_TRIANGLE_RETENTION_DIVISOR` are rejected as
/// kernel blowups.
pub(super) const CSG_TRIANGLE_RETENTION_DIVISOR: usize = 4;
/// Minimum triangle count for a valid CSG result.
pub(super) const MIN_VALID_TRIANGLES: usize = 4;
/// Per-axis AABB engulf slack shared by every engulf check (batched,
/// host-consumed, rectangular fallback, prism), so the guards cannot drift
/// apart on what counts as "engulfs the host".
pub(super) const ENGULF_TOLERANCE: f64 = 0.03;
/// [`ENGULF_TOLERANCE`] for the callers that compare in f32.
pub(super) const ENGULF_TOLERANCE_F32: f32 = 0.03;

/// The operand precision of a guard: `f32` or `f64`.
pub(super) trait Scalar:
    Copy + PartialOrd + Add<Output = Self> + Sub<Output = Self> + Mul<Output = Self>
{
    /// Floor on the host extent that scales the engulf slack, so a flat host
    /// still has a non-zero slack.
    const EXTENT_FLOOR: Self;
    fn abs(self) -> Self;
    fn max(self, other: Self) -> Self;
    /// `hi - lo`, subtracted in f32 (the precision of a mesh's bounds) and then
    /// widened to `Self`.
    fn extent(lo: f32, hi: f32) -> Self;
}

impl Scalar for f32 {
    const EXTENT_FLOOR: f32 = 1.0e-9;
    fn abs(self) -> f32 {
        f32::abs(self)
    }
    fn max(self, other: f32) -> f32 {
        f32::max(self, other)
    }
    fn extent(lo: f32, hi: f32) -> f32 {
        hi - lo
    }
}

impl Scalar for f64 {
    const EXTENT_FLOOR: f64 = 1.0e-9;
    fn abs(self) -> f64 {
        f64::abs(self)
    }
    fn max(self, other: f64) -> f64 {
        f64::max(self, other)
    }
    fn extent(lo: f32, hi: f32) -> f64 {
        (hi - lo) as f64
    }
}

/// Tier-conditional minimum opening volume (m³) floor. Shared by the batch
/// admission gate and the sequential CSG path so the two can never diverge
/// (B11 / issue #976): the 0.1 L default filters legacy-BSP CSG artefacts,
/// but at High/Highest quality it relaxes to ~1e-9 m³ so genuine small
/// openings (bolt holes / sleeves in thin plates) still get cut instead of
/// being silently skipped.
#[inline]
pub(super) fn min_opening_volume(quality: TessellationQuality) -> f64 {
    match quality {
        TessellationQuality::High | TessellationQuality::Highest => 1e-9,
        _ => MIN_OPENING_VOLUME,
    }
}

/// A cutter mesh the exact kernel can be handed: non-empty, finite, and at
/// least one triangle's worth of coordinates.
#[inline]
pub(super) fn cutter_mesh_is_valid(mesh: &Mesh) -> bool {
    !mesh.is_empty() && mesh.positions.iter().all(|&v| v.is_finite()) && mesh.positions.len() >= 9
}

/// Admit `mesh` as a cutter for a host with `host_bounds`, returning the
/// cutter's f32 bounds: valid, overlapping the host's AABB, and above the
/// volume floor. `min_volume` is in the caller's precision, and so is the
/// volume it is compared with.
pub(super) fn admit_cutter<T: Scalar>(
    mesh: &Mesh,
    host_bounds: (Point3<f32>, Point3<f32>),
    min_volume: T,
) -> Option<(Point3<f32>, Point3<f32>)> {
    if !cutter_mesh_is_valid(mesh) {
        return None;
    }
    let (host_min, host_max) = host_bounds;
    let (omn, omx) = mesh.bounds();
    let no_overlap = omx.x < host_min.x
        || omn.x > host_max.x
        || omx.y < host_min.y
        || omn.y > host_max.y
        || omx.z < host_min.z
        || omn.z > host_max.z;
    if no_overlap {
        return None;
    }
    let volume = T::extent(omn.x, omx.x) * T::extent(omn.y, omx.y) * T::extent(omn.z, omx.z);
    if volume < min_volume {
        return None;
    }
    Some((omn, omx))
}

/// Whether the box `[lo, hi]` covers the host box on EVERY axis, up to `tol`
/// of the host's extent per axis (the 3 % slack absorbs a cutter that reaches
/// roughly flush with a face).
#[inline]
pub(super) fn aabb_engulfs<T: Scalar>(
    lo: [T; 3],
    hi: [T; 3],
    host_lo: [T; 3],
    host_hi: [T; 3],
    tol: T,
) -> bool {
    (0..3).all(|k| {
        let slack = (host_hi[k] - host_lo[k]).abs().max(T::EXTENT_FLOOR) * tol;
        lo[k] <= host_lo[k] + slack && hi[k] >= host_hi[k] - slack
    })
}

/// Whether `cut` kept enough of the `tri_before` triangles the host had: a
/// non-empty result with at least `tri_before / CSG_TRIANGLE_RETENTION_DIVISOR`
/// (and [`MIN_VALID_TRIANGLES`]) triangles. Anything smaller is a kernel blowup.
#[inline]
pub(super) fn cut_retains_triangles(tri_before: usize, cut: &Mesh) -> bool {
    let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR).max(MIN_VALID_TRIANGLES);
    !cut.is_empty() && cut.triangle_count() >= min_tris
}

/// Accept `cut` as the new `result` iff it is non-empty and retained enough
/// triangles — the SAME acceptance the disjoint batching applies to its
/// `subtract_mesh_many` output (the watertightness of the cut is guaranteed
/// upstream: each cutter is `mesh_is_closed_exact`, and the kernel's conformity
/// gate rejects a non-conforming arrangement). A blanket `param_cut_watertight`
/// scan here is far too slow on the hot path. Whether the cut CHANGED the host
/// is the caller's: `mesh_to_keep` reads it from the subtract's outcome.
///
/// `max_removed` is an OVER-CUT guard: the cut is rejected if it removed more host
/// volume than the caller's provable upper bound (Σ contributing-cutter footprint
/// volumes for the coaxial prism path; `f64::INFINITY` for the exact 3D union, which
/// cannot over-cut). This catches an approximate union reconstruction — a bridged
/// depth band, a residual projection inflation — before it is committed and consumed
/// as if it were an exact cut, so the cluster instead defers to the exact path.
pub(super) fn accept_cut(result: &mut Mesh, cut: Mesh, max_removed: f64) -> bool {
    // Removed volume = host solid before − after (both same orientation). A cut that
    // removed MORE than the caller's upper bound is an over-cut → reject (defer).
    // Both readings are summed about the host's one reference point (#4632).
    let reference = volume_reference(result);
    let removed = signed_volume_about(result, &reference) - signed_volume_about(&cut, &reference);
    if cut_retains_triangles(result.triangle_count(), &cut) && removed <= max_removed {
        *result = cut;
        true
    } else {
        false
    }
}
