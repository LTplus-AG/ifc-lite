// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Surface-type tessellators: planar/boundary, B-spline, and cylindrical faces.

use crate::triangulation::{calculate_polygon_normal, project_to_2d};
use crate::{scale_segments, Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

use super::super::helpers::get_axis2_placement_transform_by_id;
use super::bounds::extract_face_bounds;
use super::bspline::tessellate_bspline_surface;
use super::bspline_budget::{MAX_BSPLINE_DEGREE, MAX_BSPLINE_SURFACE_SAMPLE_WORK};
use super::bspline_parse::{parse_control_points, parse_knot_vectors};
use super::edge_loop::extract_edge_loop_points_for_bounds;

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
pub(super) fn process_planar_face_rebased(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<(Vec<f32>, Vec<u32>)> {
    use crate::triangulation::project_to_2d_with_basis;
    let bounds = extract_face_bounds(face, decoder, quality)?;
    let Some(outer) = bounds.outer else {
        return Ok((Vec::new(), Vec::new()));
    };
    let hole_points = bounds.holes;

    let normal = calculate_polygon_normal(&outer);
    let (outer_2d, u_axis, v_axis, origin) = project_to_2d(&outer, &normal);
    let holes_2d: Vec<Vec<nalgebra::Point2<f64>>> = hole_points
        .iter()
        .map(|h| project_to_2d_with_basis(h, &u_axis, &v_axis, &origin))
        .collect();

    let mut positions = Vec::with_capacity((outer.len() + hole_points.iter().map(|h| h.len()).sum::<usize>()) * 3);
    let rtc = rtc_file_units.unwrap_or((0.0, 0.0, 0.0));
    for p in outer.iter().chain(hole_points.iter().flat_map(|h| h.iter())) {
        positions.push((p.x - rtc.0) as f32);
        positions.push((p.y - rtc.1) as f32);
        positions.push((p.z - rtc.2) as f32);
    }

    let indices = triangulate_planar_indices(&outer_2d, &holes_2d, outer.len())?;

    Ok((positions, indices))
}

fn triangulate_planar_indices(
    outer_2d: &[nalgebra::Point2<f64>],
    holes_2d: &[Vec<nalgebra::Point2<f64>>],
    outer_len: usize,
) -> Result<Vec<u32>> {
    use crate::triangulation::triangulate_polygon_with_holes;

    match triangulate_polygon_with_holes(outer_2d, holes_2d) {
        Ok(idx) => Ok(idx.into_iter().map(|i| i as u32).collect()),
        Err(_) if holes_2d.is_empty() => {
            // Preserve the historical no-hole fallback. It is never valid
            // when holes exist: filling only the outer fan would silently
            // close authored openings.
            let mut idx = Vec::with_capacity((outer_len - 2) * 3);
            for i in 1..outer_len - 1 {
                idx.push(0u32);
                idx.push(i as u32);
                idx.push(i as u32 + 1);
            }
            Ok(idx)
        }
        Err(error) => Err(Error::geometry(format!(
            "planar face triangulation with holes failed: {error}"
        ))),
    }
}

/// Process a B-spline surface face. When `weights` is `Some`, rational
/// (NURBS) evaluation is used. The control net is shifted by `rtc` (file
/// units) before evaluation, so f32 narrowing happens after a national-grid
/// offset is gone (#5698); `(0, 0, 0)` is the historical output.
pub(crate) fn process_bspline_face(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
    weights: Option<&[Vec<f64>]>,
    quality: TessellationQuality,
    rtc: (f64, f64, f64),
) -> Result<(Vec<f32>, Vec<u32>)> {
    // Get degrees
    let u_degree = bspline.get_float(0).unwrap_or(3.0) as usize;
    let v_degree = bspline.get_float(1).unwrap_or(1.0) as usize;

    // Reject a file-supplied degree far past any practical NURBS (#4901): the
    // Cox-de Boor evaluation is now memoized (`bspline_basis_table`), but a
    // huge degree still inflates its table (`O(degree * (n + degree))`) and
    // the per-sample weighted sum, and nothing legitimate needs it. This
    // fails LOUDLY (via `GeometryRouter::record_unsupported_item`, through
    // the `Err` propagated to the caller) instead of silently degrading the
    // surface, and it is a deterministic COUNT bound, not a timer, so native
    // and wasm reject the same file identically.
    if u_degree > MAX_BSPLINE_DEGREE || v_degree > MAX_BSPLINE_DEGREE {
        return Err(Error::geometry(format!(
            "BSplineSurface degree ({u_degree}, {v_degree}) exceeds the {MAX_BSPLINE_DEGREE} bound (#4901)"
        )));
    }

    // Read the control-point grid's dimensions from the RAW attribute list —
    // no `CartesianPoint` is resolved or decoded (#4901). Checking the
    // work bound against THESE, before calling `parse_control_points`,
    // means a hostile file with millions of point references is rejected
    // before paying for the decode, not after (a bound enforced only once
    // everything is already parsed and allocated is not a bound at all).
    let (raw_n_u, raw_n_v_max) = super::bspline_parse::control_point_grid_dims(bspline);
    let raw_n_v_first = bspline
        .get(2)
        .and_then(|a| a.as_list())
        .and_then(|rows| rows.first())
        .and_then(|row| row.as_list())
        .map(<[_]>::len)
        .unwrap_or(0);

    // Determine tessellation resolution based on surface complexity; scaled by quality.
    let u_segments = scale_segments(raw_n_u * 3, 8, 24, quality);
    let v_segments = if raw_n_u > 0 {
        scale_segments(raw_n_v_first * 3, 4, 24, quality)
    } else {
        scale_segments(4, 4, 24, quality)
    };

    // Bound the actual cost driver (#4901): NOT the raw control-point count
    // (a real fixture legitimately carries a 207x180 = 37,260-point patch,
    // see bspline_budget.rs) but a conservative upper bound on total work.
    // #5321 reuses axis tables and skips zero-support terms; retain the dense
    // estimate so the optimization does not change which inputs are admitted:
    // - the weighted-sum loop (`evaluate_bspline_surface`), `samples * n_u * n_v`;
    // - PLUS the per-axis basis-table build (`bspline_basis_table`), which
    //   depends on `n_u` and `n_v` INDEPENDENTLY of each other and of their
    //   product — a grid of many near-empty rows (`n_u` huge, `n_v` tiny)
    //   makes the weighted-sum term small while the U-axis table build alone
    //   is still `O(degree * n_u)` per sample point. Omitting this term let a
    //   ragged/empty-row grid slip past the bound entirely (caught in review).
    let samples = (u_segments as u64 + 1).saturating_mul(v_segments as u64 + 1);
    let n_u = raw_n_u as u64;
    let n_v = raw_n_v_max as u64;
    let deg_u = u_degree as u64;
    let deg_v = v_degree as u64;
    let weighted_sum_work = n_u.saturating_mul(n_v);
    let table_build_work = deg_u
        .saturating_mul(n_u.saturating_add(deg_u))
        .saturating_add(deg_v.saturating_mul(n_v.saturating_add(deg_v)));
    let estimated_work =
        samples.saturating_mul(weighted_sum_work.saturating_add(table_build_work));
    if estimated_work > MAX_BSPLINE_SURFACE_SAMPLE_WORK {
        return Err(Error::geometry(format!(
            "BSplineSurface sampling work ({estimated_work} = {samples} samples * \
             ({n_u}x{n_v} control points + degree-{u_degree}/{v_degree} basis tables)) \
             exceeds the {MAX_BSPLINE_SURFACE_SAMPLE_WORK} bound (#4901)"
        )));
    }

    // Parse control points (only now — the work bound above already passed
    // on the raw, undecoded grid dimensions).
    let mut control_points = parse_control_points(bspline, decoder)?;
    // Rebase the control net, not the samples (#5698): a B-spline is affine
    // invariant, and evaluating at national-grid magnitude would amplify the
    // basis' partition-of-unity rounding into micrometres. Exact for zero.
    for point in control_points.iter_mut().flatten() {
        point.x -= rtc.0;
        point.y -= rtc.1;
        point.z -= rtc.2;
    }

    // Parse knot vectors
    let (u_knots, v_knots) = parse_knot_vectors(bspline)?;

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
    rtc: (f64, f64, f64),
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

            positions.push((world_point.x - rtc.0) as f32);
            positions.push((world_point.y - rtc.1) as f32);
            positions.push((world_point.z - rtc.2) as f32);
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

#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;
