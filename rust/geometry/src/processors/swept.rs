// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept geometry processors - SweptDiskSolid and RevolvedAreaSolid.

use crate::{profiles::ProfileProcessor, Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

/// SweptDiskSolid processor
/// Handles IfcSweptDiskSolid - sweeps a circular profile along a curve
pub struct SweptDiskSolidProcessor {
    profile_processor: ProfileProcessor,
}

impl SweptDiskSolidProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }
}

impl GeometryProcessor for SweptDiskSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcSweptDiskSolid attributes:
        // 0: Directrix (IfcCurve) - the path to sweep along
        // 1: Radius (IfcPositiveLengthMeasure) - outer radius
        // 2: InnerRadius (optional) - inner radius for hollow tubes
        // 3: StartParam (optional)
        // 4: EndParam (optional)

        let directrix_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("SweptDiskSolid missing Directrix".to_string()))?;

        let radius = entity
            .get_float(1)
            .ok_or_else(|| Error::geometry("SweptDiskSolid missing Radius".to_string()))?;

        // Get inner radius if hollow
        let _inner_radius = entity.get_float(2);

        // StartParam / EndParam (optional IfcParameterValue). Per IFC spec, when the
        // directrix is an IfcCompositeCurve the curve is parameterised so that segment
        // index `i` covers parameter range [i, i+1]. Without honoring these, files that
        // intend e.g. only the first segment to be swept render every segment — the
        // common rebar case where a 2 m bar reads as 12 m with hooks unfolded.
        let start_param = entity.get_float(3);
        let end_param = entity.get_float(4);

        // Resolve the directrix curve
        let directrix = decoder
            .resolve_ref(directrix_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Directrix".to_string()))?;

        // Get points along the curve, honoring trim parameters where the directrix's
        // parameterisation is well-defined and obvious from the entity:
        //   - IfcCompositeCurve (and IfcCompositeCurveOnSurface): segment-index based,
        //     each segment contributes 1.0 to the parameter.
        //   - IfcPolyline: point-index based, each segment between consecutive points
        //     contributes 1.0 to the parameter.
        // Other directrix types (IfcLine, IfcCircle, IfcTrimmedCurve, IfcBSplineCurve)
        // have length-, angle-, or knot-based parameterisations and fall back to the
        // full sampler. Files using those with explicit StartParam/EndParam will still
        // render the full curve — flagged as a known limitation.
        let has_trim = start_param.is_some() || end_param.is_some();
        let curve_points = if has_trim
            && directrix.ifc_type.is_subtype_of(IfcType::IfcCompositeCurve)
        {
            self.profile_processor
                .get_composite_curve_points_trimmed(
                    &directrix,
                    decoder,
                    start_param,
                    end_param,
                )?
        } else if has_trim && directrix.ifc_type == IfcType::IfcPolyline {
            self.profile_processor
                .get_polyline_points_trimmed(&directrix, decoder, start_param, end_param)?
        } else {
            self.profile_processor.get_curve_points(&directrix, decoder)?
        };

        if curve_points.len() < 2 {
            return Ok(Mesh::new()); // Not enough points
        }

        // Generate tube mesh by sweeping circle along curve
        let segments = 24; // Number of segments around the circle
        let mut positions = Vec::new();
        let mut indices = Vec::new();

        // For each point on the curve, create a ring of vertices
        for i in 0..curve_points.len() {
            let p = curve_points[i];

            // Calculate tangent direction
            let tangent = if i == 0 {
                (curve_points[1] - curve_points[0]).normalize()
            } else if i == curve_points.len() - 1 {
                (curve_points[i] - curve_points[i - 1]).normalize()
            } else {
                ((curve_points[i + 1] - curve_points[i - 1]) / 2.0).normalize()
            };

            // Create perpendicular vectors using cross product
            // First, find a vector not parallel to tangent
            let up = if tangent.x.abs() < 0.9 {
                Vector3::new(1.0, 0.0, 0.0)
            } else {
                Vector3::new(0.0, 1.0, 0.0)
            };

            let perp1 = tangent.cross(&up).normalize();
            let perp2 = tangent.cross(&perp1).normalize();

            // Create ring of vertices
            for j in 0..segments {
                let angle = 2.0 * std::f64::consts::PI * j as f64 / segments as f64;
                let offset = perp1 * (radius * angle.cos()) + perp2 * (radius * angle.sin());
                let vertex = p + offset;

                positions.push(vertex.x as f32);
                positions.push(vertex.y as f32);
                positions.push(vertex.z as f32);
            }

            // Create triangles connecting this ring to the next
            if i < curve_points.len() - 1 {
                let base = (i * segments) as u32;
                let next_base = ((i + 1) * segments) as u32;

                for j in 0..segments {
                    let j_next = (j + 1) % segments;

                    // Two triangles per quad
                    indices.push(base + j as u32);
                    indices.push(next_base + j as u32);
                    indices.push(next_base + j_next as u32);

                    indices.push(base + j as u32);
                    indices.push(next_base + j_next as u32);
                    indices.push(base + j_next as u32);
                }
            }
        }

        // Add end caps
        // Start cap
        let center_idx = (positions.len() / 3) as u32;
        let start = curve_points[0];
        positions.push(start.x as f32);
        positions.push(start.y as f32);
        positions.push(start.z as f32);

        for j in 0..segments {
            let j_next = (j + 1) % segments;
            indices.push(center_idx);
            indices.push(j_next as u32);
            indices.push(j as u32);
        }

        // End cap
        let end_center_idx = (positions.len() / 3) as u32;
        let end_base = ((curve_points.len() - 1) * segments) as u32;
        let end = curve_points[curve_points.len() - 1];
        positions.push(end.x as f32);
        positions.push(end.y as f32);
        positions.push(end.z as f32);

        for j in 0..segments {
            let j_next = (j + 1) % segments;
            indices.push(end_center_idx);
            indices.push(end_base + j as u32);
            indices.push(end_base + j_next as u32);
        }

        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSweptDiskSolid]
    }
}

impl Default for SweptDiskSolidProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}

/// RevolvedAreaSolid processor
/// Handles IfcRevolvedAreaSolid - rotates a 2D profile around an axis
pub struct RevolvedAreaSolidProcessor {
    profile_processor: ProfileProcessor,
}

impl RevolvedAreaSolidProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }
}

impl GeometryProcessor for RevolvedAreaSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcRevolvedAreaSolid attributes:
        // 0: SweptArea (IfcProfileDef) - the 2D profile to revolve
        // 1: Position (IfcAxis2Placement3D) - placement of the solid
        // 2: Axis (IfcAxis1Placement) - the axis of revolution
        // 3: Angle (IfcPlaneAngleMeasure) - revolution angle in radians

        let profile_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing SweptArea".to_string()))?;

        let profile = decoder
            .resolve_ref(profile_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;

        // Get axis placement (attribute 2)
        let axis_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Axis".to_string()))?;

        let axis_placement = decoder
            .resolve_ref(axis_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Axis".to_string()))?;

        // Get angle (attribute 3)
        let angle = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Angle".to_string()))?;

        // Get the 2D profile points
        let profile_2d = self.profile_processor.process(&profile, decoder)?;
        if profile_2d.outer.is_empty() {
            return Ok(Mesh::new());
        }

        // Parse axis placement to get axis point and direction
        // IfcAxis1Placement: Location, Axis (optional)
        let axis_location = {
            let loc_attr = axis_placement
                .get(0)
                .ok_or_else(|| Error::geometry("Axis1Placement missing Location".to_string()))?;
            let loc = decoder
                .resolve_ref(loc_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve axis location".to_string()))?;
            let coords = loc
                .get(0)
                .and_then(|v| v.as_list())
                .ok_or_else(|| Error::geometry("Axis location missing coordinates".to_string()))?;
            Point3::new(
                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
            )
        };

        let axis_direction = {
            if let Some(dir_attr) = axis_placement.get(1) {
                if !dir_attr.is_null() {
                    let dir = decoder.resolve_ref(dir_attr)?.ok_or_else(|| {
                        Error::geometry("Failed to resolve axis direction".to_string())
                    })?;
                    let coords = dir.get(0).and_then(|v| v.as_list()).ok_or_else(|| {
                        Error::geometry("Axis direction missing coordinates".to_string())
                    })?;
                    Vector3::new(
                        coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                        coords.get(1).and_then(|v| v.as_float()).unwrap_or(1.0),
                        coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                    )
                    .normalize()
                } else {
                    Vector3::new(0.0, 1.0, 0.0) // Default Y axis
                }
            } else {
                Vector3::new(0.0, 1.0, 0.0) // Default Y axis
            }
        };

        // Generate revolved mesh
        // Number of segments depends on angle
        let full_circle = angle.abs() >= std::f64::consts::PI * 1.99;
        let segments = if full_circle {
            24 // Full revolution
        } else {
            ((angle.abs() / std::f64::consts::PI * 12.0).ceil() as usize).max(4)
        };

        let profile_points = &profile_2d.outer;
        let num_profile_points = profile_points.len();

        let mut positions = Vec::new();
        let mut indices = Vec::new();

        // For each segment around the revolution
        for i in 0..=segments {
            let t = if full_circle && i == segments {
                0.0 // Close the loop exactly
            } else {
                angle * i as f64 / segments as f64
            };

            // Rotation matrix around axis
            let cos_t = t.cos();
            let sin_t = t.sin();
            let (ax, ay, az) = (axis_direction.x, axis_direction.y, axis_direction.z);

            // Rodrigues' rotation formula components
            let k_matrix = |v: Vector3<f64>| -> Vector3<f64> {
                Vector3::new(
                    ay * v.z - az * v.y,
                    az * v.x - ax * v.z,
                    ax * v.y - ay * v.x,
                )
            };

            // For each point in the profile
            for (j, p2d) in profile_points.iter().enumerate() {
                // Profile point in 3D (assume profile is in XY plane, rotated around Y axis)
                // The 2D profile X becomes distance from axis, Y becomes height along axis
                let radius = p2d.x;
                let height = p2d.y;

                // Initial position before rotation (in the plane containing the axis)
                let v = Vector3::new(radius, 0.0, 0.0);

                // Rodrigues' rotation: v_rot = v*cos(t) + (k x v)*sin(t) + k*(k.v)*(1-cos(t))
                let k_cross_v = k_matrix(v);
                let k_dot_v = ax * v.x + ay * v.y + az * v.z;

                let v_rot =
                    v * cos_t + k_cross_v * sin_t + axis_direction * k_dot_v * (1.0 - cos_t);

                // Final position = axis_location + height along axis + rotated radius
                let pos = axis_location + axis_direction * height + v_rot;

                positions.push(pos.x as f32);
                positions.push(pos.y as f32);
                positions.push(pos.z as f32);

                // Create triangles (except for the last segment if it connects back)
                if i < segments && j < num_profile_points - 1 {
                    let current = (i * num_profile_points + j) as u32;
                    let next_seg = ((i + 1) * num_profile_points + j) as u32;
                    let current_next = current + 1;
                    let next_seg_next = next_seg + 1;

                    // Two triangles per quad
                    indices.push(current);
                    indices.push(next_seg);
                    indices.push(next_seg_next);

                    indices.push(current);
                    indices.push(next_seg_next);
                    indices.push(current_next);
                }
            }
        }

        // Add end caps if not a full revolution
        if !full_circle {
            // Start cap
            let start_center_idx = (positions.len() / 3) as u32;
            let start_center = axis_location
                + axis_direction
                    * (profile_points.iter().map(|p| p.y).sum::<f64>()
                        / profile_points.len() as f64);
            positions.push(start_center.x as f32);
            positions.push(start_center.y as f32);
            positions.push(start_center.z as f32);

            for j in 0..num_profile_points - 1 {
                indices.push(start_center_idx);
                indices.push(j as u32 + 1);
                indices.push(j as u32);
            }

            // End cap
            let end_center_idx = (positions.len() / 3) as u32;
            let end_base = (segments * num_profile_points) as u32;
            positions.push(start_center.x as f32);
            positions.push(start_center.y as f32);
            positions.push(start_center.z as f32);

            for j in 0..num_profile_points - 1 {
                indices.push(end_center_idx);
                indices.push(end_base + j as u32);
                indices.push(end_base + j as u32 + 1);
            }
        }

        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcRevolvedAreaSolid]
    }
}

impl Default for RevolvedAreaSolidProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}
