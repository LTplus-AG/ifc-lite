// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Surface-type tessellators: planar/boundary, B-spline, and cylindrical faces.

use crate::triangulation::{calculate_polygon_normal, project_to_2d};
use crate::{scale_segments, Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

use super::super::helpers::get_axis2_placement_transform_by_id;
use super::bspline::{parse_control_points, parse_knot_vectors, tessellate_bspline_surface};
use super::edge_loop::{extract_edge_loop_points, extract_edge_loop_points_for_bounds};

/// Process a planar or boundary-represented face.
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
/// Mirrors the FacetedBrep path in `processors/brep.rs`: pick the outer
/// (or first) bound, project to 2D using its basis, project hole bounds
/// using the SAME basis, and call `triangulate_polygon_with_holes` once.
pub(super) fn process_planar_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<(Vec<f32>, Vec<u32>)> {
    use crate::triangulation::{project_to_2d_with_basis, triangulate_polygon_with_holes};
    use ifc_lite_core::IfcType;

    let bounds_attr = face
        .get(0)
        .ok_or_else(|| Error::geometry("AdvancedFace missing Bounds".to_string()))?;
    let bounds = bounds_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected bounds list".to_string()))?;

    // Collect (points, is_outer, orientation) per bound. Orientation is
    // attribute 1 of IfcFaceBound; when .F., the loop must be reversed.
    let mut outer_points: Option<Vec<Point3<f64>>> = None;
    let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

    for bound in bounds {
        let Some(bound_id) = bound.as_entity_ref() else {
            continue;
        };
        let bound_entity = decoder.decode_by_id(bound_id)?;

        let loop_attr = bound_entity
            .get(0)
            .ok_or_else(|| Error::geometry("FaceBound missing Bound".to_string()))?;
        let loop_entity = decoder
            .resolve_ref(loop_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve loop".to_string()))?;
        if !loop_entity.ifc_type.as_str().eq_ignore_ascii_case("IFCEDGELOOP") {
            continue;
        }

        let mut points = extract_edge_loop_points(&loop_entity, decoder, quality);
        if points.len() < 3 {
            continue;
        }
        let orientation = bound_entity
            .get(1)
            .and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE")
            .unwrap_or(true);
        if !orientation {
            points.reverse();
        }

        let is_outer = bound_entity.ifc_type == IfcType::IfcFaceOuterBound;
        if is_outer || outer_points.is_none() {
            if is_outer {
                if let Some(prev_outer) = outer_points.take() {
                    hole_points.push(prev_outer);
                }
            }
            outer_points = Some(points);
        } else {
            hole_points.push(points);
        }
    }

    let Some(outer) = outer_points else {
        return Ok((Vec::new(), Vec::new()));
    };

    let normal = calculate_polygon_normal(&outer);
    let (outer_2d, u_axis, v_axis, origin) = project_to_2d(&outer, &normal);
    let holes_2d: Vec<Vec<nalgebra::Point2<f64>>> = hole_points
        .iter()
        .map(|h| project_to_2d_with_basis(h, &u_axis, &v_axis, &origin))
        .collect();

    let mut positions = Vec::with_capacity((outer.len() + hole_points.iter().map(|h| h.len()).sum::<usize>()) * 3);
    for p in outer.iter().chain(hole_points.iter().flat_map(|h| h.iter())) {
        positions.push(p.x as f32);
        positions.push(p.y as f32);
        positions.push(p.z as f32);
    }

    let indices = match triangulate_polygon_with_holes(&outer_2d, &holes_2d) {
        Ok(idx) => idx.into_iter().map(|i| i as u32).collect(),
        Err(_) => {
            // Outer-only fan fallback. Drops holes — same behaviour as the
            // pre-fix code on a no-hole face, so worst case matches the old
            // legacy path rather than emitting nothing.
            let mut idx = Vec::with_capacity((outer.len() - 2) * 3);
            for i in 1..outer.len() - 1 {
                idx.push(0u32);
                idx.push(i as u32);
                idx.push(i as u32 + 1);
            }
            idx
        }
    };

    Ok((positions, indices))
}

/// Process a B-spline surface face.
/// When `weights` is `Some`, rational (NURBS) evaluation is used.
pub(crate) fn process_bspline_face(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
    weights: Option<&[Vec<f64>]>,
    quality: TessellationQuality,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // Get degrees
    let u_degree = bspline.get_float(0).unwrap_or(3.0) as usize;
    let v_degree = bspline.get_float(1).unwrap_or(1.0) as usize;

    // Parse control points
    let control_points = parse_control_points(bspline, decoder)?;

    // Parse knot vectors
    let (u_knots, v_knots) = parse_knot_vectors(bspline)?;

    // Determine tessellation resolution based on surface complexity; scaled by quality.
    let u_segments = scale_segments(control_points.len() * 3, 8, 24, quality);
    let v_segments = if !control_points.is_empty() {
        scale_segments(control_points[0].len() * 3, 4, 24, quality)
    } else {
        scale_segments(4, 4, 24, quality)
    };

    // Tessellate the surface (returns None if knot data is inconsistent)
    match tessellate_bspline_surface(
        u_degree,
        v_degree,
        &control_points,
        &u_knots,
        &v_knots,
        weights,
        u_segments,
        v_segments,
    ) {
        Some((positions, indices)) => Ok((positions, indices)),
        None => Ok((Vec::new(), Vec::new())),
    }
}

/// Process a cylindrical surface face
pub(super) fn process_cylindrical_face(
    face: &DecodedEntity,
    surface: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // Get the radius from IfcCylindricalSurface (attribute 1)
    let radius = surface
        .get(1)
        .and_then(|v| v.as_float())
        .ok_or_else(|| Error::geometry("CylindricalSurface missing Radius".to_string()))?;

    // Get position/axis from IfcCylindricalSurface (attribute 0)
    let position_attr = surface.get(0);
    let axis_transform = if let Some(attr) = position_attr {
        if let Some(pos_id) = attr.as_entity_ref() {
            get_axis2_placement_transform_by_id(pos_id, decoder)?
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
        extract_edge_loop_points_for_bounds(face, decoder, quality);

    if boundary_points.is_empty() {
        return Ok((Vec::new(), Vec::new()));
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
    angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    angles.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

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
        if span < 1e-6 || span > std::f64::consts::TAU - 1e-6 {
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

    let mut positions = Vec::new();
    let mut indices = Vec::new();

    // Generate cylinder patch vertices
    for h in 0..=height_segments {
        let z = min_z + (height * h as f64 / height_segments as f64);
        for a in 0..=angle_segments {
            let angle = min_angle + (angle_span * a as f64 / angle_segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();

            // Transform back to world coordinates
            let local_point = Point3::new(x, y, z);
            let world_point = axis_transform.transform_point(&local_point);

            positions.push(world_point.x as f32);
            positions.push(world_point.y as f32);
            positions.push(world_point.z as f32);
        }
    }

    // Generate indices for quad strip
    let cols = angle_segments + 1;
    for h in 0..height_segments {
        for a in 0..angle_segments {
            let base = (h * cols + a) as u32;
            let next_row = base + cols as u32;

            // Two triangles per quad
            indices.push(base);
            indices.push(base + 1);
            indices.push(next_row + 1);

            indices.push(base);
            indices.push(next_row + 1);
            indices.push(next_row);
        }
    }

    Ok((positions, indices))
}
