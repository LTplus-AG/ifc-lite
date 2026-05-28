// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept geometry processors - SweptDiskSolid and RevolvedAreaSolid.

use crate::{
    extrusion::apply_transform, profiles::ProfileProcessor, Error, Mesh, Point3, Result, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::helpers::parse_axis2_placement_3d;
use crate::router::GeometryProcessor;

/// Build a rotation-minimising frame (RMF) for sweeping a circular cross-section
/// along `curve_points`. Returns `(tangents, perp1s, perp2s)`, each of length
/// `curve_points.len()`.
///
/// The previous implementation re-picked the cross-section's `up` vector at
/// every sample based on `tangent.x.abs() < 0.9`. When two consecutive tangents
/// straddled that threshold, `up` flipped, swapping the sign of `perp1` between
/// rings — visible as a twisted / flat-ribbon tube at sharp bends.
///
/// RMF instead picks `up` ONCE for the first sample, then propagates the frame
/// by rotating it from `tangents[i-1]` onto `tangents[i]` (the minimum rotation
/// that aligns them). When consecutive tangents are parallel the frame stays
/// untouched.
fn build_tube_rmf(
    curve_points: &[Point3<f64>],
) -> (Vec<Vector3<f64>>, Vec<Vector3<f64>>, Vec<Vector3<f64>>) {
    let n = curve_points.len();
    let mut tangents = Vec::with_capacity(n);
    let mut perp1s = Vec::with_capacity(n);
    let mut perp2s = Vec::with_capacity(n);
    if n < 2 {
        return (tangents, perp1s, perp2s);
    }

    for i in 0..n {
        let t = if i == 0 {
            (curve_points[1] - curve_points[0]).normalize()
        } else if i == n - 1 {
            (curve_points[i] - curve_points[i - 1]).normalize()
        } else {
            ((curve_points[i + 1] - curve_points[i - 1]) / 2.0).normalize()
        };
        tangents.push(t);
    }

    let up0 = if tangents[0].x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    let mut perp1 = tangents[0].cross(&up0).normalize();
    let mut perp2 = tangents[0].cross(&perp1).normalize();
    perp1s.push(perp1);
    perp2s.push(perp2);

    for i in 1..n {
        let prev = tangents[i - 1];
        let curr = tangents[i];
        let cos_a = prev.dot(&curr).clamp(-1.0, 1.0);
        let axis = prev.cross(&curr);
        let axis_norm = axis.norm();
        // Skip rotation when tangents are (nearly) parallel — frame is preserved.
        // Anti-parallel (cos_a ≈ -1) leaves axis ill-defined, but a 180° turn
        // between consecutive samples on a swept-disk directrix is physically
        // implausible; we keep the previous frame and accept the degraded case.
        if axis_norm > 1e-9 && cos_a < 1.0 - 1e-12 {
            let axis = axis / axis_norm;
            let sin_a = (1.0 - cos_a * cos_a).max(0.0).sqrt();
            // Rodrigues' rotation of `perp1` around `axis` by angle = acos(cos_a)
            perp1 = perp1 * cos_a
                + axis.cross(&perp1) * sin_a
                + axis * axis.dot(&perp1) * (1.0 - cos_a);
            perp1 = perp1.normalize();
            perp2 = curr.cross(&perp1).normalize();
        }
        perp1s.push(perp1);
        perp2s.push(perp2);
    }

    (tangents, perp1s, perp2s)
}

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

        // Build a rotation-minimising frame across all sample points up-front.
        // (Per-iteration `up` selection caused frame flips at sharp bends.)
        let (_, perp1s, perp2s) = build_tube_rmf(&curve_points);

        // For each point on the curve, create a ring of vertices
        for i in 0..curve_points.len() {
            let p = curve_points[i];
            let perp1 = perp1s[i];
            let perp2 = perp2s[i];

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
        // IfcRevolvedAreaSolid attributes (inherits IfcSweptAreaSolid):
        // 0: SweptArea (IfcProfileDef) - 2D profile in xy plane of Position
        // 1: Position (IfcAxis2Placement3D) - solid's local coord system
        // 2: Axis (IfcAxis1Placement) - revolution axis in xy plane of Position
        // 3: Angle (IfcPlaneAngleMeasure) - revolution angle in radians

        let profile_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing SweptArea".to_string()))?;
        let profile = decoder
            .resolve_ref(profile_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;

        // Position transform: maps Position-local coords -> object coords.
        // Optional in some files; default to identity.
        let position_transform = if let Some(pos_attr) = entity.get(1) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    parse_axis2_placement_3d(&pos_entity, decoder)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        let axis_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Axis".to_string()))?;
        let axis_placement = decoder
            .resolve_ref(axis_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Axis".to_string()))?;

        let angle = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Angle".to_string()))?;

        let profile_2d = self.profile_processor.process(&profile, decoder)?;
        if profile_2d.outer.is_empty() {
            return Ok(Mesh::new());
        }

        // IfcAxis1Placement: 0=Location (IfcCartesianPoint), 1=Axis (IfcDirection, optional)
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
                    let raw = Vector3::new(
                        coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                        coords.get(1).and_then(|v| v.as_float()).unwrap_or(1.0),
                        coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                    );
                    if raw.norm() < 1e-12 {
                        Vector3::new(0.0, 1.0, 0.0)
                    } else {
                        raw.normalize()
                    }
                } else {
                    Vector3::new(0.0, 1.0, 0.0)
                }
            } else {
                Vector3::new(0.0, 1.0, 0.0)
            }
        };

        let full_circle = angle.abs() >= std::f64::consts::PI * 1.99;
        let segments = if full_circle {
            24
        } else {
            ((angle.abs() / std::f64::consts::PI * 12.0).ceil() as usize).max(8)
        };

        let profile_points = &profile_2d.outer;
        let num_profile_points = profile_points.len();

        let ring_count = if full_circle { segments } else { segments + 1 };
        let mut positions = Vec::with_capacity(ring_count * num_profile_points * 3);
        let mut indices = Vec::new();

        // Rotate each profile vertex around the axis line in Position-local coords.
        for i in 0..ring_count {
            let t = if full_circle {
                std::f64::consts::TAU * i as f64 / segments as f64
            } else {
                angle * i as f64 / segments as f64
            };

            let cos_t = t.cos();
            let sin_t = t.sin();
            let k = axis_direction;

            for p2d in profile_points {
                // Lift profile vertex into Position-local 3D (xy plane, z=0)
                let p_local = Point3::new(p2d.x, p2d.y, 0.0);

                // Decompose v = (p_local - axis_location) into parallel + perpendicular
                // to the axis, then rotate only the perpendicular component by t.
                let v = p_local - axis_location;
                let v_par_len = v.dot(&k);
                let v_par = k * v_par_len;
                let v_perp = v - v_par;
                let v_perp_rot = v_perp * cos_t + k.cross(&v_perp) * sin_t;

                let pos_local = axis_location + v_par + v_perp_rot;

                positions.push(pos_local.x as f32);
                positions.push(pos_local.y as f32);
                positions.push(pos_local.z as f32);
            }
        }

        // Side quads. The last ring connects back to the first only when the
        // sweep closes the loop (full revolution).
        let segment_quads = segments;
        for i in 0..segment_quads {
            let ring_a = i;
            let ring_b = (i + 1) % ring_count;
            for j in 0..num_profile_points {
                let j_next = (j + 1) % num_profile_points;
                let a = (ring_a * num_profile_points + j) as u32;
                let b = (ring_b * num_profile_points + j) as u32;
                let c = (ring_b * num_profile_points + j_next) as u32;
                let d = (ring_a * num_profile_points + j_next) as u32;
                indices.push(a);
                indices.push(b);
                indices.push(c);
                indices.push(a);
                indices.push(c);
                indices.push(d);
            }
        }

        // End caps for a partial revolution. Build fan triangles from the
        // profile centroid for each end ring. Cheap and good enough for the
        // structural-beam case the IFC spec targets here.
        if !full_circle && num_profile_points >= 3 {
            let centroid_2d = {
                let (sx, sy) = profile_points
                    .iter()
                    .fold((0.0, 0.0), |(sx, sy), p| (sx + p.x, sy + p.y));
                let n = num_profile_points as f64;
                Point3::new(sx / n, sy / n, 0.0)
            };

            for (ring_idx, flip) in [(0usize, true), (segments, false)] {
                let t = if ring_idx == 0 {
                    0.0
                } else {
                    angle
                };
                let cos_t = t.cos();
                let sin_t = t.sin();
                let k = axis_direction;

                let v = centroid_2d - axis_location;
                let v_par = k * v.dot(&k);
                let v_perp = v - v_par;
                let v_perp_rot = v_perp * cos_t + k.cross(&v_perp) * sin_t;
                let center = axis_location + v_par + v_perp_rot;

                let center_idx = (positions.len() / 3) as u32;
                positions.push(center.x as f32);
                positions.push(center.y as f32);
                positions.push(center.z as f32);

                let base = (ring_idx * num_profile_points) as u32;
                for j in 0..num_profile_points {
                    let j_next = (j + 1) % num_profile_points;
                    let a = base + j as u32;
                    let b = base + j_next as u32;
                    if flip {
                        indices.push(center_idx);
                        indices.push(b);
                        indices.push(a);
                    } else {
                        indices.push(center_idx);
                        indices.push(a);
                        indices.push(b);
                    }
                }
            }
        }

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        };

        // Apply Position to lift Position-local coords into object coords.
        apply_transform(&mut mesh, &position_transform);

        Ok(mesh)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rmf_is_constant_on_a_straight_line() {
        // Three collinear samples → tangents identical → frame must not change.
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
        ];
        let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
        assert_eq!(tangents.len(), 3);
        for i in 1..3 {
            assert!((tangents[i] - tangents[0]).norm() < 1e-9);
            assert!((perp1s[i] - perp1s[0]).norm() < 1e-9);
            assert!((perp2s[i] - perp2s[0]).norm() < 1e-9);
        }
    }

    #[test]
    fn rmf_does_not_flip_at_sharp_bends() {
        // L-shape (0,0,0) → (1,0,0) → (1,1,0). The previous implementation
        // re-picked `up` per cross-section based on `tangent.x.abs() < 0.9`:
        // at i=0 tangent is +X (|x|=1, picks up=Y) → perp1 = +Z; at i=1 the
        // midpoint tangent is (1/√2, 1/√2, 0) (|x|≈0.71 < 0.9, picks up=X)
        // → perp1 = -Z. The sign flip mirrors the cross-section ring and
        // produces a twisted/flat-ribbon tube. RMF must propagate +Z through.
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(1.0, 1.0, 0.0),
        ];
        let (_, perp1s, _) = build_tube_rmf(&pts);
        assert_eq!(perp1s.len(), 3);
        for (i, p) in perp1s.iter().enumerate() {
            assert!(
                p.z > 0.5,
                "perp1 at i={i} flipped or rotated out of +Z half-space: {p:?}"
            );
        }
    }

    #[test]
    fn rmf_handles_degenerate_inputs() {
        let empty: Vec<Point3<f64>> = Vec::new();
        let (t, p1, p2) = build_tube_rmf(&empty);
        assert!(t.is_empty() && p1.is_empty() && p2.is_empty());

        let single = vec![Point3::new(0.0, 0.0, 0.0)];
        let (t, p1, p2) = build_tube_rmf(&single);
        assert!(t.is_empty() && p1.is_empty() && p2.is_empty());
    }
}
