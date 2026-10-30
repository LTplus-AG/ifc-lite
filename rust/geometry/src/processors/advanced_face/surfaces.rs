// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source admission for planar boundaries and cylindrical patches.

use super::analytic_plan::{CylinderPlan, PlanarPlan};
use super::bounds::extract_face_bounds;
use super::edge_loop::extract_edge_loop_points_for_bounds;
use super::plan::FaceGeometry;
use crate::math::tol;
use crate::placement::Axis2Placement;
use crate::{scale_segments, Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// Read a planar or boundary-represented face's loops.
///
/// Per IFC 4.3 `IfcAdvancedFace`, `Bounds` is a list of `IfcFaceBound` —
/// at most one is `IfcFaceOuterBound` (the outer ring), the rest are holes.
/// The previous implementation triangulated each bound as an independent
/// polygon and concatenated, which meant a face with one outer + one hole
/// emitted a solid outer quad PLUS a reversed-winding solid quad over the
/// hole — exactly coplanar, opposite normals, overlapping in the hole's
/// footprint. With the renderer running `cullMode: 'none'` ("IFC winding
/// order varies", `packages/renderer/src/pipeline.ts`), that pair surfaced
/// as a Z-fight on the door panel's glass cutout (issue #674 follow-up).
///
/// The plan shares `triangulate_planar_face` with the FacetedBrep path: the
/// outer (or first) bound and the hole bounds are projected on one basis and
/// triangulated once.
pub(super) fn lower_planar(face: &DecodedEntity, decoder: &mut EntityDecoder,
    quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>) -> Result<FaceGeometry> {
    let bounds = extract_face_bounds(face, decoder, quality)?;
    let Some(outer) = bounds.outer else {
        return Ok(FaceGeometry::Empty);
    };
    let hole_points = bounds.holes;

    Ok(FaceGeometry::Planar(PlanarPlan { outer, hole_points,
        rtc: rtc_file_units.unwrap_or((0.0, 0.0, 0.0)) }))
}

#[cfg(test)]
pub(super) fn process_planar_face_rebased(face: &DecodedEntity, decoder: &mut EntityDecoder,
    quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>) -> Result<(Vec<f32>, Vec<u32>)> {
    lower_planar(face, decoder, quality, rtc_file_units)?.evaluate()
}

#[cfg(test)]
pub(crate) fn process_bspline_face(bspline: &DecodedEntity, decoder: &mut EntityDecoder,
    weights: Option<&[Vec<f64>]>, quality: TessellationQuality, rtc: (f64, f64, f64)) -> Result<(Vec<f32>, Vec<u32>)> {
    super::bspline_plan::lower_bspline(bspline, decoder, weights.map(<[Vec<f64>]>::to_vec), quality, rtc)?.evaluate()
}

pub(super) fn lower_cylindrical(
    face: &DecodedEntity,
    surface: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc: (f64, f64, f64),
) -> Result<Option<CylinderPlan>> {
    // Get the radius from IfcCylindricalSurface (attribute 1)
    let radius = surface
        .attr(slot::IfcCylindricalSurface::RADIUS)
        .and_then(|v| v.as_float())
        .ok_or_else(|| Error::geometry("CylindricalSurface missing Radius".to_string()))?;

    // Get position/axis from IfcCylindricalSurface (attribute 0)
    let position_attr = surface.attr(slot::IfcCylindricalSurface::POSITION);
    let axis_transform = if let Some(attr) = position_attr {
        if let Some(pos_id) = attr.as_entity_ref() {
            Axis2Placement::read_id(pos_id, decoder)?.matrix()
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    // Extract boundary points using the shared edge-loop sampler so that
    // B-spline and circle edges contribute interpolated points (instead of
    // collapsing the boundary to vertex corners). This is critical for the
    // glazing-mullion fillet faces in IFC4 door exports, where each
    // cylindrical face has B-spline edge curves running along the surface.
    let boundary_points: Vec<Point3<f64>> =
        extract_edge_loop_points_for_bounds(face, decoder, quality)?;

    if boundary_points.is_empty() {
        return Ok(None);
    }

    // Transform boundary points to local cylinder coordinates
    let inv_transform = axis_transform
        .try_inverse()
        .unwrap_or(Matrix4::identity());
    let local_points: Vec<Point3<f64>> = boundary_points
        .iter()
        .map(|p| inv_transform.transform_point(p))
        .collect();

    // Determine angular extent via the largest-gap-on-the-circle algorithm
    // (same approach as SoR). Robust to faces that straddle θ=π — the
    // previous min/max + wrap heuristic could give a 270° span for a
    // half-cylinder face whose samples cluster at the seam, leaving a
    // visible misalignment with the opposite half.
    let mut angles: Vec<f64> = local_points
        .iter()
        .map(|p| {
            let mut a = p.y.atan2(p.x);
            if a < 0.0 {
                a += std::f64::consts::TAU;
            }
            a
        })
        .collect();
    angles.sort_by(|a, b| crate::cmp_f64_nan_last(*a, *b)); // #7674
    angles.dedup_by(|a, b| (*a - *b).abs() < tol::ANGLE_EPS);

    let (min_angle, max_angle) = if angles.len() < 2 {
        (0.0, std::f64::consts::TAU)
    } else {
        let n = angles.len();
        let mut max_gap = 0.0;
        let mut max_gap_idx = 0usize;
        for i in 0..n {
            let next = if i + 1 < n {
                angles[i + 1]
            } else {
                angles[0] + std::f64::consts::TAU
            };
            let gap = next - angles[i];
            if gap > max_gap {
                max_gap = gap;
                max_gap_idx = i;
            }
        }
        let start = angles[(max_gap_idx + 1) % n];
        let end_raw = angles[max_gap_idx];
        let end = if end_raw < start {
            end_raw + std::f64::consts::TAU
        } else {
            end_raw
        };
        let span = end - start;
        if span < tol::ANGLE_EPS || span > std::f64::consts::TAU - tol::ANGLE_EPS {
            (0.0, std::f64::consts::TAU)
        } else {
            (start, end)
        }
    };

    let mut min_z = f64::MAX;
    let mut max_z = f64::MIN;
    for p in &local_points {
        min_z = min_z.min(p.z);
        max_z = max_z.max(p.z);
    }

    // Tessellation parameters
    let angle_span = max_angle - min_angle;
    let height = max_z - min_z;

    // Balance between accuracy and matching web-ifc's output
    // Use ~10 degrees per segment for smooth handle/glazing curvature; scaled by quality.
    let angle_base = (angle_span / (std::f64::consts::PI / 18.0)).ceil() as usize;
    let angle_segments = scale_segments(angle_base, 6, 32, quality);
    // Height segments based on aspect ratio - at least 1, more for tall cylinders.
    let height_base = (height / (radius * 2.0)).ceil() as usize;
    let height_segments = scale_segments(height_base, 1, 8, quality);

    Ok(Some(CylinderPlan { radius, axis_transform, min_angle, angle_span,
        min_z, height, angle_segments, height_segments, rtc }))
}

#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;
