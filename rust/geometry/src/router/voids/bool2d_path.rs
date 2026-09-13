// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D opening-subtraction fast path (IfcOpenShell's `boolean-attempt-2d`).
//! For the common case — an extruded host whose openings penetrate straight
//! through the extrusion depth — the exact 3D mesh-boolean is replaced by a much
//! cheaper operation: subtract the openings' footprints from the host's 2D
//! profile ([`crate::bool2d::subtract_multiple_2d`], i_overlay), then re-extrude
//! the holed profile. On CSG-heavy models the void-cut is ~80% of geometry time
//! and the exact kernel is at its single-threaded, bandwidth-bound floor; this
//! path collapses each qualifying host to a couple of profile triangulations.
//! HYBRID eligibility subtracts parallel through-cuts in 2D. Perpendicular,
//! partial-depth, and non-extruded openings remain residual 3D cuts on the
//! re-extruded host, so one ineligible opening does not forfeit the cheap ones.
//! Pure 2D cuts union overlapping footprints. Mixed cuts stage a stable precursor,
//! residual cuts, and mandatory overlap corrections; only their complete union
//! difference may be returned. This avoids changing the residual cutter's input
//! tessellation when overlapping footprints merge (#4617).
//! Safety gates validate the 2D PREFIX before residual routing:
//!   1. Host body = ONE `IfcExtrudedAreaSolid` swept along local ±Z (arbitrary
//!      profile OK; mapped items unwrapped; a clipped / multi-item body defers).
//!   2. Each eligible footprint lands STRICTLY INTERIOR to the host profile
//!      (gated at capture). A footprint touching or breaching the boundary is
//!      routed to the residual instead.
//!   3. The difference must yield ONE connected shape (a void that splits the
//!      profile is rejected — the largest-shape keep would drop geometry) with at
//!      least one hole formed.
//!   4. The no-hole re-extrude reconciles with the host mesh (bounds + volume),
//!      and the holed re-extrude self-checks watertight. The later residual result
//!      is not certified by this gate; #4610 pins its established census reading.
//!
//! A prefix-gate failure falls through with the full opening set unchanged.
//!
//! Gate: `IFC_LITE_VOID_2D=0` forces every host back through the exact kernel
//! (A/B measurement / bisection). Default ON. wasm has no env, so the default
//! holds on both targets and native==wasm output stays deterministic (all-f64
//! before the f32 store).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use super::geom::{mesh_signed_volume, param_cut_watertight};
use super::{world_host_bounds, GeometryRouter, VoidContext};
use crate::bool2d::{subtract_multiple_2d_counted, subtract_staged_2d_counted};
use crate::extrusion::{apply_transform, extrude_profile, extrude_profile_watertight};
use crate::mesh::Mesh;
use crate::profile::Profile2D;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point2, Vector3};

mod footprint;
use footprint::{footprint_interior, opening_solid_footprint};

/// `IFC_LITE_VOID_2D=0` disables the 2D opening-subtraction path (exact kernel
/// for every host). Default ON; read once.
pub(super) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_VOID_2D").as_deref() != Ok("0"))
}

static FIRES: AtomicU64 = AtomicU64::new(0);
static FOOTPRINTS: AtomicU64 = AtomicU64::new(0);

/// Read + reset the 2D-path telemetry: (hosts cut via the 2D path, opening
/// footprints subtracted in those hosts). Process-global; used by the perf
/// harness to report the fast-path hit-rate. Relaxed atomics — a stale read
/// under concurrency only mis-reports a diagnostic count, never geometry.
pub fn take_bool2d_stats() -> (u64, u64) {
    (
        FIRES.swap(0, Ordering::Relaxed),
        FOOTPRINTS.swap(0, Ordering::Relaxed),
    )
}

/// Captured 2D-subtraction data for a host + its openings, sufficient to build
/// the cut mesh WITHOUT the decoder (so [`GeometryRouter::apply_void_context`]
/// can run it on pure geometry). Built in [`GeometryRouter::capture_bool2d`].
pub(super) struct Bool2dCut {
    /// Host profile (outer + any existing holes) in the solid's profile plane.
    host_profile: Profile2D,
    /// Host extrusion depth (> 0).
    depth: f64,
    /// +1 / -1 host sweep sense (drives the extrude cap placement).
    dir_sign: f64,
    /// Profile-local → world (metres, RTC-relative) transform: `scale · m − rtc`.
    wt: Matrix4<f64>,
    /// Eligible (parallel through-cut) opening footprints in the host profile
    /// plane (host XY).
    footprints: Vec<Vec<Point2<f64>>>,
    /// Ineligible openings (perpendicular / partial / non-extruded) as a residual
    /// exact-kernel context, cut on the re-extruded host after the 2D subtract.
    /// `None` when every opening was eligible (pure 2D result).
    residual: Option<Box<VoidContext>>,
}

impl GeometryRouter {
    /// Build the 2D-subtraction data for a host + its openings. Splits the
    /// openings into eligible (parallel through-cut → 2D) and residual
    /// (everything else → exact kernel). Returns `None` if the host is not a
    /// single clean extrusion or no opening is eligible (nothing to gain).
    pub(super) fn capture_bool2d(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Option<Bool2dCut> {
        if opening_ids.is_empty() {
            return None;
        }
        let host = self.host_extruded_solid(element, decoder)?;
        let hm_inv = host.m.try_inverse()?;
        let host_rot = host.m.fixed_view::<3, 3>(0, 0).into_owned();
        let host_axis = (host_rot * Vector3::new(0.0, 0.0, host.dir_sign)).try_normalize(1e-9)?;
        // Host extrusion span in the solid's profile frame.
        let (hz_min, hz_max) = if host.dir_sign >= 0.0 {
            (0.0, host.depth)
        } else {
            (-host.depth, 0.0)
        };
        // Numerical-precision coincidence (1 ppm): near-through blind openings
        // defer to the exact kernel instead of becoming a full-depth hole.
        let z_tol = 1.0e-6 * host.depth.abs() + 1.0e-9;

        let mut footprints: Vec<Vec<Point2<f64>>> = Vec::new();
        let mut residual_ids: Vec<u32> = Vec::new();
        for &oid in opening_ids {
            let opening = match decoder.decode_by_id(oid) {
                Ok(e) if e.ifc_type == IfcType::IfcOpeningElement => e,
                // A non-opening (or undecodable) id: hand it to the exact kernel.
                _ => {
                    residual_ids.push(oid);
                    continue;
                }
            };
            // An opening is eligible only when EVERY constituent solid is a
            // parallel through-cut whose hole-free footprint lands STRICTLY
            // INTERIOR to the host profile. A footprint that touches / breaches
            // the boundary, or lands in an existing profile hole, is routed to
            // the residual so it never silently no-ops. Collect tentatively; any
            // ineligible solid sends the
            // whole opening (all its solids) to the residual so nothing is
            // double-cut.
            let mut opening_footprints: Vec<Vec<Point2<f64>>> = Vec::new();
            let eligible = self
                .opening_extruded_solids(&opening, decoder)
                .map(|solids| {
                    solids.iter().all(|op| {
                        match opening_solid_footprint(
                            op, &hm_inv, &host_axis, hz_min, hz_max, z_tol,
                        ) {
                            Some(fp) if footprint_interior(&fp, &host.profile) => {
                                opening_footprints.push(fp);
                                true
                            }
                            _ => false,
                        }
                    })
                })
                .unwrap_or(false);
            if eligible && !opening_footprints.is_empty() {
                footprints.append(&mut opening_footprints);
            } else {
                residual_ids.push(oid);
            }
        }
        if footprints.is_empty() {
            return None;
        }

        // Profile-local → world metres, RTC-relative: world = scale·(m·p) − rtc.
        // Scaling rows 0..3 (incl. their translation column) then subtracting the
        // RTC offset reproduces `center_native · s − rtc` from the rect probe.
        let s = self.unit_scale;
        let (rx, ry, rz) = self.rtc_offset;
        let mut wt = host.m;
        for i in 0..3 {
            for j in 0..4 {
                wt[(i, j)] *= s;
            }
        }
        wt[(0, 3)] -= rx;
        wt[(1, 3)] -= ry;
        wt[(2, 3)] -= rz;

        // Residual exact-kernel context for the ineligible openings (diagnostics
        // suppressed — the full opening set is already diagnosed by
        // `build_void_context`'s own `classify_openings`).
        let residual = if residual_ids.is_empty() {
            None
        } else {
            let openings = self.classify_openings_quiet(element, &residual_ids, decoder);
            if openings.is_empty() {
                None
            } else {
                let merged = Self::merge_rectangular_openings(&openings);
                Some(Box::new(VoidContext {
                    openings,
                    merged_openings: merged,
                    param: None,
                    bool2d: None,
                }))
            }
        };

        Some(Bool2dCut {
            host_profile: host.profile,
            depth: host.depth,
            dir_sign: host.dir_sign,
            wt,
            footprints,
            residual,
        })
    }

    /// Emit the staged re-extruded precursor and mandatory correction cutters.
    /// The caller must cut residual openings, then remove all corrections before
    /// returning a mixed result. Returns `None` (→ full exact kernel) if
    /// reconciliation or the watertight self-check fails. Deterministic f64 →
    /// byte-identical native==wasm.
    pub(super) fn try_bool2d_cut(&self, mesh: &Mesh, cut: &Bool2dCut) -> Option<(Mesh, Vec<Mesh>)> {
        // A -Z sweep places the profile plane at the TOP; shift the [0, depth]
        // extrude down so the solid occupies [-depth, 0] in the profile frame,
        // matching the extruded-solid processor's downward-extrusion handling.
        let transform = if cut.dir_sign >= 0.0 {
            None
        } else {
            Some(Matrix4::new_translation(&Vector3::new(
                0.0, 0.0, -cut.depth,
            )))
        };

        // (1) No-hole solid: reconcile transform + profile recovery against the
        // real (pre-cut) host mesh. A clipped / mis-recovered host mismatches here
        // and defers, so the emitted geometry can only ever be a true extrusion.
        let mut solid = extrude_profile(&cut.host_profile, cut.depth, transform).ok()?;
        apply_transform(&mut solid, &cut.wt);
        if !reconcile_solid(mesh, &solid) {
            return None;
        }

        // (2) 2D difference. The one pathology interiority can't rule out is a
        // void that SPLITS the profile into
        // disconnected pieces (an interior slot bridging the outer to an existing
        // hole): the difference then yields multiple shapes and only the largest
        // is kept, silently dropping geometry. Reject any multi-shape result and
        // require at least one hole to have formed (a zero-hole result would signal
        // a projection error rather than a real cut).
        let (holed, n_shapes, corrections) = if cut.residual.is_some() {
            subtract_staged_2d_counted(&cut.host_profile, &cut.footprints).ok()?
        } else {
            let (profile, count) = subtract_multiple_2d_counted(&cut.host_profile, &cut.footprints).ok()?;
            (profile, count, Vec::new())
        };
        if n_shapes != 1 {
            return None;
        }
        if holed.holes.len() < cut.host_profile.holes.len() + 1 {
            return None;
        }

        // (3) Re-extrude the holed profile (watertight CDT caps) into the host's
        // OWN frame: fold the host mesh's per-element origin into the transform so
        // the result carries the SAME `origin` (world = origin + position). On the
        // native/world default `mesh.origin` is 0 and this is the absolute world
        // build; under the wasm local-frame default it keeps the cut near its own
        // origin (f32-precise for a georeferenced host — the #1297 precondition)
        // instead of collapsing to coarse absolute-world coordinates. Hygiene +
        // the watertight self-check run in this frame (small coords, precise).
        let origin = mesh.origin;
        let mut wt = cut.wt;
        wt[(0, 3)] -= origin[0];
        wt[(1, 3)] -= origin[1];
        wt[(2, 3)] -= origin[2];
        let mut out = extrude_profile_watertight(&holed, cut.depth, transform).ok()?;
        apply_transform(&mut out, &wt);
        out.origin = origin;
        out.clean_degenerate();
        if !param_cut_watertight(&out) {
            return None;
        }

        let corrections = corrections
            .iter()
            .map(|profile| {
                if !profile.holes.is_empty() {
                    return None;
                }
                let mut correction = extrude_profile_watertight(profile, cut.depth, transform).ok()?;
                apply_transform(&mut correction, &wt);
                correction.origin = origin;
                Some(correction)
            })
            .collect::<Option<Vec<_>>>()?;
        let footprints = cut.footprints.len() as u64;
        crate::telemetry_transaction::record(move || {
            FIRES.fetch_add(1, Ordering::Relaxed);
            FOOTPRINTS.fetch_add(footprints, Ordering::Relaxed);
        });
        Some((out, corrections))
    }

    /// The captured residual (ineligible-opening) exact-kernel context, if any.
    pub(super) fn bool2d_residual<'a>(&self, cut: &'a Bool2dCut) -> Option<&'a VoidContext> {
        cut.residual.as_deref()
    }
}

/// Reconcile the no-hole re-extruded `solid` against the real host `mesh` by
/// world AABB (per axis) and signed volume. Validates that the recovered profile
/// and composed transform reproduce the host — catching clipped hosts, unit / RTC
/// mistakes, and profiles the processor tessellates differently.
fn reconcile_solid(host: &Mesh, solid: &Mesh) -> bool {
    let (hmn, hmx) = world_host_bounds(host); // folds host.origin
    let (smn, smx) = solid.bounds(); // solid is absolute (origin 0)
    let hmn = [hmn.0, hmn.1, hmn.2];
    let hmx = [hmx.0, hmx.1, hmx.2];
    let smn = [smn.x, smn.y, smn.z];
    let smx = [smx.x, smx.y, smx.z];
    for k in 0..3 {
        let ext = (hmx[k] - hmn[k]).abs().max(1e-3);
        let tol = ext * 0.02 + 5e-3; // 2% of extent + 5 mm
        if (hmn[k] - smn[k]).abs() > tol || (hmx[k] - smx[k]).abs() > tol {
            return false;
        }
    }
    let hv = mesh_signed_volume(host).abs();
    let sv = mesh_signed_volume(solid).abs();
    if hv < 1e-9 || sv < 1e-9 {
        return false;
    }
    let r = sv / hv;
    (0.97..1.03).contains(&r)
}

#[cfg(test)]
#[path = "bool2d_path_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "bool2d_transaction_tests.rs"]
mod transaction_tests;
