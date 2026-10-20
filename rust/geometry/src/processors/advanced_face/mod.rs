// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared advanced face processing logic.
//!
//! Handles `IfcAdvancedFace` and `IfcFaceSurface` with B-spline, planar, and
//! cylindrical surface types. Used by B-rep processors and structural
//! reference topology.

#[cfg(test)]
use crate::{Result, TessellationQuality};
#[cfg(test)]
use ifc_lite_core::EntityDecoder;
use ifc_lite_core::{slot, DecodedEntity};

mod analytic_plan;
pub(super) mod bounds;
mod bspline;
mod bspline_budget;
mod bspline_parse;
mod bspline_plan;
mod conics;
mod curves;
pub(super) mod edge_loop;
mod plan;
mod polyline;
mod revolution;
mod surfaces;

pub(super) use bspline_parse::parse_rational_weights;
pub(super) use bspline_plan::{lower_bspline, BSplinePlan};
pub(super) use plan::{lower_face, FacePlan};

// Re-exported crate-wide: the router (a sibling top-level module, not a
// descendant of `processors`) drains this once per representation item to
// report a capped B-spline curve edge (#4901); see `bspline_budget.rs`.
pub(crate) use bspline_budget::take_curve_capped;
pub(crate) use bounds::take_face_refused;
pub(super) use bounds::note_face_refused;

/// Restore reports captured by an owner between synchronous slices without
/// discarding reports already pending for the caller on this thread.
pub(crate) fn restore_reports(curve_capped: bool, face_types: &[ifc_lite_core::IfcType]) {
    if curve_capped {
        bspline_budget::note_curve_capped();
    }
    for ty in face_types {
        bounds::note_face_refused(ty);
    }
}

/// A known approximation, recorded rather than silent (#7687, PROC-S20): a
/// B-spline face is tessellated over the surface's whole knot domain, and its
/// `Bounds` (outer trim and holes) are not applied, so a trimmed NURBS patch
/// renders untrimmed and its holes closed. Trimming in parameter space is
/// planned with the shared curve sampler (charter #7670, C1a).
fn note_untrimmed_bspline_face(face: &DecodedEntity) {
    let bound_count = face
        .get(slot::IfcFaceSurface::BOUNDS.index())
        .and_then(|a| a.as_list())
        .map_or(0, <[_]>::len);
    if bound_count == 0 {
        return;
    }
    crate::diag::diag_debug!(
        { face_id = face.id, bounds = bound_count,
          "advanced_face: B-spline face bounds not applied, tessellating the untrimmed surface" }
        else {
            #[cfg(feature = "debug_geometry")]
            eprintln!(
                "[ifc-lite][advanced_face] B-spline face #{} untrimmed ({} bounds ignored)",
                face.id, bound_count
            );
        }
    );
}

/// Process a single `IfcAdvancedFace` or `IfcFaceSurface` by lowering it to a
/// [`FacePlan`] and evaluating that plan.
///
/// Returns (positions, indices) for the tessellated face. With
/// `rtc_file_units`, every surface handler removes the offset in f64 BEFORE
/// narrowing to f32, so a national-grid face keeps detail below one f32 ULP
/// (#5698). `None` is the historical unshifted output.
#[cfg(test)]
pub(super) fn process_advanced_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<(Vec<f32>, Vec<u32>)> {
    lower_face(face, decoder, quality, rtc_file_units)?.evaluate()
}
