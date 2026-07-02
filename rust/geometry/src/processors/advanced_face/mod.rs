// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared advanced face processing logic.
//!
//! Handles IfcAdvancedFace with B-spline, planar, and cylindrical surface types.
//! Used by both AdvancedBrepProcessor and ShellBasedSurfaceModelProcessor/FaceBasedSurfaceModelProcessor
//! when shells contain IfcAdvancedFace entities (common in CATIA exports).

use crate::{Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

mod bspline;
mod curves;
mod edge_loop;
mod polyline;
mod revolution;
mod surfaces;

// Re-exported so sibling processors that reference
// `super::advanced_face::{parse_rational_weights, process_bspline_face}` keep resolving.
pub(super) use bspline::parse_rational_weights;
pub(super) use surfaces::process_bspline_face;

use revolution::process_surface_of_revolution_face;
use surfaces::{process_cylindrical_face, process_planar_face};

/// Process a single IfcAdvancedFace entity, dispatching to the appropriate
/// surface handler based on FaceSurface type.
///
/// Returns (positions, indices) for the tessellated face.
pub(super) fn process_advanced_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // IfcAdvancedFace has:
    // 0: Bounds (list of FaceBound)
    // 1: FaceSurface (IfcSurface - Plane, BSplineSurface, CylindricalSurface, etc.)
    // 2: SameSense (boolean)

    let surface_attr = face
        .get(1)
        .ok_or_else(|| Error::geometry("AdvancedFace missing FaceSurface".to_string()))?;

    let surface = decoder
        .resolve_ref(surface_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface".to_string()))?;

    let surface_type = surface.ifc_type.as_str().to_uppercase();

    // Read SameSense (attribute 2) - when false, triangle winding must be flipped
    let same_sense = face
        .get(2)
        .and_then(|a| a.as_enum())
        .map(|e| e == "T" || e == "TRUE")
        .unwrap_or(true);

    let result = if surface_type == "IFCPLANE" {
        process_planar_face(face, decoder, quality)
    } else if surface_type == "IFCBSPLINESURFACEWITHKNOTS" {
        process_bspline_face(&surface, decoder, None, quality)
    } else if surface_type == "IFCRATIONALBSPLINESURFACEWITHKNOTS" {
        let weights = parse_rational_weights(&surface);
        process_bspline_face(&surface, decoder, weights.as_deref(), quality)
    } else if surface_type == "IFCCYLINDRICALSURFACE" {
        process_cylindrical_face(face, &surface, decoder, quality)
    } else if surface_type == "IFCSURFACEOFREVOLUTION" {
        process_surface_of_revolution_face(face, &surface, decoder, quality)
    } else if surface_type == "IFCSURFACEOFLINEAREXTRUSION"
        || surface_type == "IFCCONICALSURFACE"
        || surface_type == "IFCSPHERICALSURFACE"
        || surface_type == "IFCTOROIDALSURFACE"
    {
        // For these surface types, the edge loop boundary vertices already lie
        // on the surface. Extracting and triangulating them gives a reasonable
        // polygonal approximation. This covers IfcSurfaceOfLinearExtrusion
        // (common in CATIA exports) and other analytic surface types.
        process_planar_face(face, decoder, quality)
    } else {
        // Unsupported surface type - return empty geometry
        #[cfg(feature = "debug_geometry")]
        eprintln!(
            "[ifc-lite][advanced_face] face #{} unsupported surface {}",
            face.id, surface_type
        );
        Ok((Vec::new(), Vec::new()))
    };

    #[cfg(feature = "debug_geometry")]
    {
        if let Ok((ref pos, ref idx)) = result {
            if pos.is_empty() || idx.is_empty() {
                eprintln!(
                    "[ifc-lite][advanced_face] face #{} surface={} produced 0 tris (verts={}, idx={})",
                    face.id,
                    surface_type,
                    pos.len() / 3,
                    idx.len() / 3,
                );
            }
        }
    }

    // When SameSense is false, flip triangle winding to correct face orientation
    if !same_sense {
        result.map(|(positions, mut indices)| {
            for tri in indices.chunks_exact_mut(3) {
                tri.swap(0, 2);
            }
            (positions, indices)
        })
    } else {
        result
    }
}
