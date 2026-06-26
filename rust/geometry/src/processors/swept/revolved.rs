// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    extrusion::apply_transform, profiles::ProfileProcessor, scale_segments, Error, Mesh, Point3,
    Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::super::helpers::parse_axis2_placement_3d;
use super::super::tessellated::PolygonalFaceSetProcessor;
use crate::router::GeometryProcessor;

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
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // IfcRevolvedAreaSolid attributes (inherits IfcSweptAreaSolid):
        // 0: SweptArea (IfcProfileDef) - 2D profile in xy plane of Position
        // 1: Position (IfcAxis2Placement3D) - solid's local coord system
        // 2: Axis (IfcAxis1Placement) - revolution axis in xy plane of Position
        // 3: Angle (IfcPlaneAngleMeasure) - revolution angle in the project's
        //    PLANEANGLEUNIT (radians for SI files, degrees for files that
        //    declare a DEGREE conversion-based unit). Scaled to radians below
        //    via decoder.plane_angle_to_radians() — see issue #820 for the
        //    same class of bug on IfcTrimmedCurve parameters.

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
            .ok_or_else(|| Error::geometry("RevolvedAreaSolid missing Angle".to_string()))?
            * decoder.plane_angle_to_radians();

        let profile_2d = self.profile_processor.process(&profile, decoder, quality)?;
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
        // 24 segments for a full revolve at Medium; ~12 per 180° (min 8) for a
        // partial arc. Both scaled by quality; the high upper bound preserves
        // the original uncapped partial-arc count at Medium.
        let segments = if full_circle {
            scale_segments(24, 8, 96, quality)
        } else {
            let base = (angle.abs() / std::f64::consts::PI * 12.0).ceil() as usize;
            scale_segments(base, 8, 4096, quality)
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

        // End caps for a partial revolution.
        //
        // Originally a fan from the profile centroid to consecutive
        // boundary points. That assumption only holds for CONVEX
        // profiles — for a concave profile (I-beam, L-beam, hollow
        // rectangle …) the centroid lies outside the polygon in some
        // regions, the fan triangles cross each other, and the cap
        // renders as a bow-tie/X artifact (issue #846 follow-up: PR
        // #848 sweep landed correctly but the I-beam cross-section came
        // out as a zigzag because of this fan path).
        //
        // Use earcut on the 2D profile boundary instead. The resulting
        // triangle indices are in [0..num_profile_points) — they map
        // 1:1 onto the ring vertices we already emitted, so the cap
        // just reuses those positions (no new vertices except the side-
        // wall winding requires flipping one of the two caps so its
        // outward normal points away from the swept volume).
        if !full_circle && num_profile_points >= 3 {
            let profile_flat: Vec<f64> = profile_points
                .iter()
                .flat_map(|p| [p.x, p.y])
                .collect();
            let cap_indices = crate::triangulation::safe_earcut(&profile_flat, &[], 2)
                .map_err(|e| Error::geometry(format!(
                    "Revolved profile cap triangulation failed: {e}"
                )))?;

            for (ring_idx, flip) in [(0usize, true), (segments, false)] {
                let base = (ring_idx * num_profile_points) as u32;
                for tri in cap_indices.chunks_exact(3) {
                    let a = base + tri[0] as u32;
                    let b = base + tri[1] as u32;
                    let c = base + tri[2] as u32;
                    if flip {
                        indices.push(a);
                        indices.push(c);
                        indices.push(b);
                    } else {
                        indices.push(a);
                        indices.push(b);
                        indices.push(c);
                    }
                }
            }
        }

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false, 
            origin: [0.0; 3],        instance_meta: None, };

        // Apply Position to lift Position-local coords into object coords.
        apply_transform(&mut mesh, &position_transform);

        // Profile-boundary creases (e.g. flange-to-web on an I-beam) are
        // all sharp 90° edges, but the swept mesh shares vertices between
        // adjacent side quads — so per-vertex normal averaging smooths the
        // shading across every crease and the cross-section reads as a
        // smooth blob. Flat-shade the whole revolved solid (each triangle
        // gets its own three vertices with the face normal) so the
        // shading matches the actual geometry.
        let flat =
            PolygonalFaceSetProcessor::build_flat_shaded_mesh(&mesh.positions, &mesh.indices);
        mesh.positions = flat.positions;
        mesh.normals = flat.normals;
        mesh.indices = flat.indices;

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
