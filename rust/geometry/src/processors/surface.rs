// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SurfaceOfLinearExtrusion processor - surface sweep geometry.

use crate::{Error, Mesh, Point2, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::helpers::{get_axis2_placement_transform_by_id, get_direction_by_id};
use crate::router::GeometryProcessor;

/// SurfaceOfLinearExtrusion processor
/// Handles IfcSurfaceOfLinearExtrusion - surface created by sweeping a curve along a direction
pub struct SurfaceOfLinearExtrusionProcessor;

impl SurfaceOfLinearExtrusionProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl GeometryProcessor for SurfaceOfLinearExtrusionProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcSurfaceOfLinearExtrusion attributes:
        // 0: SweptCurve (IfcProfileDef - usually IfcArbitraryOpenProfileDef)
        // 1: Position (IfcAxis2Placement3D)
        // 2: ExtrudedDirection (IfcDirection)
        // 3: Depth (length)

        // Get the swept curve (profile)
        let curve_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("SurfaceOfLinearExtrusion missing SweptCurve".to_string())
        })?;

        let curve_id = curve_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for SweptCurve".to_string())
        })?;

        // Get position
        let position_attr = entity.get(1);
        let position_transform = if let Some(attr) = position_attr {
            if let Some(pos_id) = attr.as_entity_ref() {
                get_axis2_placement_transform_by_id(pos_id, decoder)?
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Get extrusion direction
        let direction_attr = entity.get(2).ok_or_else(|| {
            Error::geometry("SurfaceOfLinearExtrusion missing ExtrudedDirection".to_string())
        })?;

        let direction = if let Some(dir_id) = direction_attr.as_entity_ref() {
            get_direction_by_id(dir_id, decoder)
                .ok_or_else(|| Error::geometry("Failed to get direction".to_string()))?
        } else {
            Vector3::new(0.0, 0.0, 1.0) // Default to Z-up
        };

        // Get depth
        let depth = entity
            .get(3)
            .and_then(|v| v.as_float())
            .ok_or_else(|| Error::geometry("SurfaceOfLinearExtrusion missing Depth".to_string()))?;

        // Get curve points from the profile
        let curve_points = Self::get_profile_curve_points(curve_id, decoder)?;

        if curve_points.len() < 2 {
            return Ok(Mesh::new());
        }

        // Extrude the curve to create a surface (quad strip)
        let extrusion = direction.normalize() * depth;

        let mut positions = Vec::with_capacity(curve_points.len() * 2 * 3);
        let mut indices = Vec::with_capacity((curve_points.len() - 1) * 6);

        // Create vertices: bottom row, then top row
        for point in &curve_points {
            // Transform 2D point to 3D using position
            let p3d = position_transform.transform_point(&Point3::new(point.x, point.y, 0.0));
            positions.push(p3d.x as f32);
            positions.push(p3d.y as f32);
            positions.push(p3d.z as f32);
        }

        for point in &curve_points {
            // Extruded point
            let p3d = position_transform.transform_point(&Point3::new(point.x, point.y, 0.0));
            let p_extruded = p3d + extrusion;
            positions.push(p_extruded.x as f32);
            positions.push(p_extruded.y as f32);
            positions.push(p_extruded.z as f32);
        }

        // Create quad strip triangles
        let n = curve_points.len() as u32;
        for i in 0..n - 1 {
            // Two triangles per quad
            // Triangle 1: bottom-left, bottom-right, top-left
            indices.push(i);
            indices.push(i + 1);
            indices.push(i + n);

            // Triangle 2: bottom-right, top-right, top-left
            indices.push(i + 1);
            indices.push(i + n + 1);
            indices.push(i + n);
        }

        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSurfaceOfLinearExtrusion]
    }
}

impl SurfaceOfLinearExtrusionProcessor {
    /// Extract curve points from a profile definition
    fn get_profile_curve_points(
        profile_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let profile = decoder.decode_by_id(profile_id)?;

        // IfcArbitraryOpenProfileDef: 0=ProfileType, 1=ProfileName, 2=Curve
        // IfcArbitraryClosedProfileDef: 0=ProfileType, 1=ProfileName, 2=OuterCurve
        let curve_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Profile missing curve".to_string()))?;

        let curve_id = curve_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity reference for curve".to_string()))?;

        // Get curve entity to determine type
        let curve = decoder.decode_by_id(curve_id)?;

        match curve.ifc_type {
            IfcType::IfcPolyline => {
                // IfcPolyline: attribute 0 is Points (list of IfcCartesianPoint)
                let point_ids = decoder
                    .get_polyloop_point_ids_fast(curve_id)
                    .ok_or_else(|| Error::geometry("Failed to get polyline points".to_string()))?;

                let mut points = Vec::with_capacity(point_ids.len());
                for point_id in point_ids {
                    if let Some((x, y, _z)) = decoder.get_cartesian_point_fast(point_id) {
                        points.push(Point2::new(x, y));
                    }
                }
                Ok(points)
            }
            IfcType::IfcCompositeCurve => {
                // Handle composite curves by extracting segments
                Self::extract_composite_curve_points(curve_id, decoder)
            }
            _ => {
                // Fallback: try to get points directly
                if let Some(point_ids) = decoder.get_polyloop_point_ids_fast(curve_id) {
                    let mut points = Vec::with_capacity(point_ids.len());
                    for point_id in point_ids {
                        if let Some((x, y, _z)) = decoder.get_cartesian_point_fast(point_id) {
                            points.push(Point2::new(x, y));
                        }
                    }
                    Ok(points)
                } else {
                    Ok(Vec::new())
                }
            }
        }
    }

    /// Extract points from a composite curve
    fn extract_composite_curve_points(
        curve_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let curve = decoder.decode_by_id(curve_id)?;

        // IfcCompositeCurve: attribute 0 is Segments (list of IfcCompositeCurveSegment)
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segment_refs = segments_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segment list".to_string()))?;

        let mut all_points = Vec::new();

        for seg_ref in segment_refs {
            let seg_id = seg_ref.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for segment".to_string())
            })?;

            let segment = decoder.decode_by_id(seg_id)?;

            // IfcCompositeCurveSegment: 0=Transition, 1=SameSense, 2=ParentCurve
            let parent_curve_attr = segment
                .get(2)
                .ok_or_else(|| Error::geometry("Segment missing ParentCurve".to_string()))?;

            let parent_curve_id = parent_curve_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for parent curve".to_string())
            })?;

            // Recursively get points from the parent curve
            if let Ok(segment_points) = Self::get_profile_curve_points(parent_curve_id, decoder) {
                // Skip first point if we already have points (to avoid duplicates at joints)
                let start_idx = if all_points.is_empty() { 0 } else { 1 };
                all_points.extend(segment_points.into_iter().skip(start_idx));
            }
        }

        Ok(all_points)
    }
}

impl Default for SurfaceOfLinearExtrusionProcessor {
    fn default() -> Self {
        Self::new()
    }
}
