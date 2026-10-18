// SPDX-License-Identifier: MPL-2.0
//! Owned curve samples, f64 placement/extrusion and RTC for an open swept strip.
//! Lengths remain in file units and f64 work precedes output narrowing. This
//! construction is an open surface, not a solid boolean operand.
use crate::{math::tol, Error, Mesh, Point2, Point3, Result, Vector3};
use crate::processors::{helpers::get_direction_by_id, SurfaceOfLinearExtrusionProcessor};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

#[derive(Debug, Clone)]
pub(crate) struct LinearExtrusionSurfacePlan {
    curve_points: Vec<Point2<f64>>,
    position_transform: Matrix4<f64>,
    extrusion: Vector3<f64>,
    rtc_file_units: Option<(f64, f64, f64)>,
}

pub(super) fn lower(entity: &DecodedEntity, decoder: &mut EntityDecoder,
    rtc_file_units: Option<(f64, f64, f64)>) -> Result<LinearExtrusionSurfacePlan> {
    let curve_id = entity.get(slot::IfcSurfaceOfLinearExtrusion::SWEPT_CURVE.index()).ok_or_else(|| {
        Error::geometry("SurfaceOfLinearExtrusion missing SweptCurve".to_string())
    })?;
    let curve_id = curve_id.as_entity_ref().ok_or_else(|| {
        Error::geometry("Expected entity reference for SweptCurve".to_string())
    })?;
    let position_transform = SurfaceOfLinearExtrusionProcessor::position_transform(entity, decoder)?;
    let direction_attr = entity.get(slot::IfcSurfaceOfLinearExtrusion::EXTRUDED_DIRECTION.index()).ok_or_else(|| {
        Error::geometry("SurfaceOfLinearExtrusion missing ExtrudedDirection".to_string())
    })?;
    let direction = match direction_attr.as_entity_ref() {
        Some(dir_id) => get_direction_by_id(dir_id, decoder)
            .ok_or_else(|| Error::geometry("Failed to get direction".to_string()))?,
        None => Vector3::new(0.0, 0.0, 1.0), // Default to Z-up
    };
    // `IfcPositiveLengthMeasure`: zero or negative is refused, not meshed
    // as a degenerate or reversed strip.
    let depth = entity.get(slot::IfcSurfaceOfLinearExtrusion::DEPTH.index()).and_then(|v| v.as_float()).ok_or_else(|| {
        Error::geometry("SurfaceOfLinearExtrusion missing Depth".to_string())
    })?;
    if !(depth > 0.0 && depth.is_finite()) {
        return Err(Error::geometry(format!(
            "SurfaceOfLinearExtrusion Depth {depth} is not a positive length"
        )));
    }

    // Fewer than two points is refused, not `Ok(empty)`: an empty mesh is
    // dropped uncounted, where main refused (and counted) the type.
    let curve_points = SurfaceOfLinearExtrusionProcessor::get_profile_curve_points(curve_id, decoder)?;
    if curve_points.len() < 2 {
        return Err(Error::geometry(format!(
            "SurfaceOfLinearExtrusion SweptCurve has {} point(s)",
            curve_points.len()
        )));
    }

    // Normalize in the constructor Position frame before source validation.
    let unit = direction.try_normalize(tol::NORMALIZE_NONZERO).ok_or_else(|| {
        Error::geometry("SurfaceOfLinearExtrusion ExtrudedDirection has zero length".to_string())
    })?;
    let extrusion = position_transform.transform_vector(&(unit * depth));

    // A strip with no area (coincident points, or a direction along a
    // straight curve) is refused rather than published empty (D3).
    let swept = |a: &Point2<f64>, b: &Point2<f64>| {
        let seg = position_transform.transform_vector(&Vector3::new(b.x - a.x, b.y - a.y, 0.0));
        seg.cross(&extrusion).norm() > f64::EPSILON * seg.norm() * extrusion.norm()
    };
    if !curve_points.windows(2).any(|w| swept(&w[0], &w[1])) {
        return Err(Error::geometry("SurfaceOfLinearExtrusion sweeps no area".to_string()));
    }

    Ok(LinearExtrusionSurfacePlan { curve_points, position_transform, extrusion, rtc_file_units })
}

impl LinearExtrusionSurfacePlan {
    pub(crate) fn evaluate(&self) -> Mesh {
        let Self { curve_points, position_transform, extrusion, rtc_file_units } = self;
        // Vertices: bottom row, then top row, rebased in f64 first.
        let mut positions = Vec::with_capacity(curve_points.len() * 2 * 3);
        let rtc = rtc_file_units.map_or_else(Vector3::zeros, |(x, y, z)| Vector3::new(x, y, z));
        for offset in [Vector3::zeros(), *extrusion] {
            for point in curve_points {
                let p3d = position_transform.transform_point(&Point3::new(point.x, point.y, 0.0));
                let p = p3d + offset - rtc;
                positions.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
            }
        }

        // Quad strip: (bottom-left, bottom-right, top-left) and
        // (bottom-right, top-right, top-left) per segment.
        let n = curve_points.len() as u32;
        let indices: Vec<u32> = (0..n - 1)
            .flat_map(|i| [i, i + 1, i + n, i + 1, i + n + 1, i + n])
            .collect();

        Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: rtc_file_units.is_some(),
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],        instance_meta: None, local_bounds: None, local_to_world: None }
    }
}

#[cfg(test)]
#[path = "surface_plan_tests.rs"]
mod tests;
