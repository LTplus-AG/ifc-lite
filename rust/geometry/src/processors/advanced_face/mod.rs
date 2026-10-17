// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared advanced face processing logic.
//!
//! Handles `IfcAdvancedFace` and `IfcFaceSurface` with B-spline, planar, and
//! cylindrical surface types. Used by B-rep processors and structural
//! reference topology.

use crate::{Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

pub(super) mod bounds;
mod bspline;
mod bspline_budget;
mod bspline_parse;
mod conics;
mod curves;
pub(super) mod edge_loop;
mod polyline;
mod revolution;
mod surfaces;

// Re-exported so sibling processors that reference
// `super::advanced_face::{parse_rational_weights, process_bspline_face}` keep resolving.
pub(super) use bspline_parse::parse_rational_weights;
pub(super) use surfaces::process_bspline_face;

// Re-exported crate-wide: the router (a sibling top-level module, not a
// descendant of `processors`) drains this once per representation item to
// report a capped B-spline curve edge (#4901); see `bspline_budget.rs`.
pub(crate) use bspline_budget::take_curve_capped;
pub(crate) use bounds::take_face_refused;
pub(super) use bounds::note_face_refused;

use revolution::process_surface_of_revolution_face;
use surfaces::{process_cylindrical_face, process_planar_face_rebased};

/// Reverse the winding of `result` when the face's `SameSense` is `.F.`.
pub(super) fn apply_same_sense(
    face: &DecodedEntity,
    result: Result<(Vec<f32>, Vec<u32>)>,
) -> Result<(Vec<f32>, Vec<u32>)> {
    let same_sense = face
        .get(2)
        .and_then(|a| a.as_enum())
        .map(|e| e == "T" || e == "TRUE")
        .unwrap_or(true);
    if same_sense {
        result
    } else {
        result.map(|(positions, mut indices)| {
            for tri in indices.chunks_exact_mut(3) {
                tri.swap(0, 2);
            }
            (positions, indices)
        })
    }
}

/// A known approximation, recorded rather than silent (#7687, PROC-S20): a
/// B-spline face is tessellated over the surface's whole knot domain, and its
/// `Bounds` (outer trim and holes) are not applied, so a trimmed NURBS patch
/// renders untrimmed and its holes closed. Trimming in parameter space is
/// planned with the shared curve sampler (charter #7670, C1a).
fn note_untrimmed_bspline_face(face: &DecodedEntity) {
    let bound_count = face.get(0).and_then(|a| a.as_list()).map_or(0, <[_]>::len);
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

/// Process a single `IfcAdvancedFace` or `IfcFaceSurface`, dispatching to the
/// appropriate surface handler based on `FaceSurface` type.
///
/// Returns (positions, indices) for the tessellated face. With
/// `rtc_file_units`, every surface handler removes the offset in f64 BEFORE
/// narrowing to f32, so a national-grid face keeps detail below one f32 ULP
/// (#5698). `None` is the historical unshifted output.
pub(super) fn process_advanced_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // IfcAdvancedFace and IfcFaceSurface have:
    // 0: Bounds (list of FaceBound)
    // 1: FaceSurface (IfcSurface - Plane, BSplineSurface, CylindricalSurface, etc.)
    // 2: SameSense (boolean)

    let surface_attr = face
        .get(1)
        .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface".to_string()))?;

    let surface = decoder
        .resolve_ref(surface_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface".to_string()))?;

    let surface_type = surface.ifc_type.as_str().to_uppercase();

    // SameSense (attribute 2) relates the SURFACE normal to the face normal.
    // Only the surface-parameterised tessellations take their winding from the
    // surface, so only they flip on `.F.`. Planar and loop-derived faces
    // triangulate their bound loops, which already wind about the face normal
    // (ISO 10303-42), and are never flipped (#7686, PROC-S16).
    let rtc = rtc_file_units.unwrap_or((0.0, 0.0, 0.0));
    let result = if surface_type == "IFCPLANE" {
        process_planar_face_rebased(face, decoder, quality, rtc_file_units)
    } else if surface_type == "IFCBSPLINESURFACEWITHKNOTS" {
        note_untrimmed_bspline_face(face);
        // Every B-spline surface error is a refusal of its data (a bound,
        // a malformed grid, knot vector or weights), counted (D3).
        apply_same_sense(
            face,
            bounds::noting_refusal(process_bspline_face(&surface, decoder, None, quality, rtc)),
        )
    } else if surface_type == "IFCRATIONALBSPLINESURFACEWITHKNOTS" {
        note_untrimmed_bspline_face(face);
        apply_same_sense(
            face,
            bounds::noting_refusal(parse_rational_weights(&surface).and_then(|weights| {
                process_bspline_face(&surface, decoder, Some(&weights), quality, rtc)
            })),
        )
    } else if surface_type == "IFCCYLINDRICALSURFACE" {
        apply_same_sense(face, process_cylindrical_face(face, &surface, decoder, quality, rtc))
    } else if surface_type == "IFCSURFACEOFREVOLUTION" {
        apply_same_sense(
            face,
            process_surface_of_revolution_face(face, &surface, decoder, quality, rtc),
        )
    } else if surface_type == "IFCSURFACEOFLINEAREXTRUSION"
        || surface_type == "IFCCONICALSURFACE"
        || surface_type == "IFCSPHERICALSURFACE"
        || surface_type == "IFCTOROIDALSURFACE"
    {
        // For these surface types, the edge loop boundary vertices already lie
        // on the surface. Extracting and triangulating them gives a reasonable
        // polygonal approximation. This covers IfcSurfaceOfLinearExtrusion
        // (common in CATIA exports) and other analytic surface types.
        process_planar_face_rebased(face, decoder, quality, rtc_file_units)
    } else {
        // Unsupported surface type - return empty geometry
        crate::diag::diag_debug!(
            { face_id = face.id, surface = %surface_type,
              "advanced_face: unsupported surface type, emitting empty geometry" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!(
                    "[ifc-lite][advanced_face] face #{} unsupported surface {}",
                    face.id, surface_type
                );
            }
        );
        Ok((Vec::new(), Vec::new()))
    };

    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    if let Ok((ref pos, ref idx)) = result {
        if pos.is_empty() || idx.is_empty() {
            crate::diag::diag_debug!(
                { face_id = face.id, surface = %surface_type,
                  verts = pos.len() / 3, indices = idx.len() / 3,
                  "advanced_face: face produced zero triangles" }
                else {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!(
                        "[ifc-lite][advanced_face] face #{} surface={} produced 0 tris (verts={}, idx={})",
                        face.id,
                        surface_type,
                        pos.len() / 3,
                        idx.len() / 3,
                    );
                }
            );
        }
    }

    result
}
