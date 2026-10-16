// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::extrusion_generic::{outward_is_right_hand, Ring};
use crate::profile::{triangulate_rings, Profile2D};
use crate::{
    extrusion::apply_transform, profiles::ProfileProcessor, scale_segments, Error, Mesh, Point2,
    Point3, Result, TessellationQuality, Vector3,
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

        // One solid per disjoint area: a composite profile is several (#7685).
        self.profile_processor.arm_solid_budget();
        let mut regions = self.profile_processor.process_regions(&profile, decoder, quality)?;
        regions.retain(|region| region.outer.len() >= 3);
        if regions.is_empty() {
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

        // Every ring point is placed once per step: refuse a composite whose
        // revolution would exceed the output cap before building it.
        let ring_count = if full_circle { segments } else { segments + 1 };
        let placed = regions.iter().map(crate::profiles::region_points).sum::<usize>() * ring_count;
        crate::profiles::check_composite_sweep(placed, regions.len(), entity.id)?;

        let sweep = Revolution {
            axis_location,
            axis_direction,
            angle,
            full_circle,
            segments,
        };
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for region in &regions {
            sweep.emit_region(region, &mut positions, &mut indices)?;
        }

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false, 
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],        instance_meta: None, local_bounds: None, local_to_world: None };

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

/// One `IfcRevolvedAreaSolid` sweep, in Position-local coordinates: the
/// profile lies in the xy plane and turns about the line through
/// `axis_location` along unit `axis_direction`.
struct Revolution {
    axis_location: Point3<f64>,
    axis_direction: Vector3<f64>,
    /// Radians; the sign is the sense of rotation about `axis_direction`.
    angle: f64,
    full_circle: bool,
    segments: usize,
}

impl Revolution {
    /// Revolve one region (outer ring plus its holes) into a closed shell
    /// wound outward, appending to `positions` / `indices`.
    ///
    /// Each ring step lays out the outer ring then every hole, the vertex
    /// order `triangulate_rings` indexes, so the end caps address ring slots
    /// directly. Walls of every ring use the shared extrusion rule
    /// (`outward_is_right_hand`), so a hole's walls face into the hole and
    /// neither the authored winding nor the sense of rotation can turn a
    /// wall against its caps (PROC-4, #7685).
    fn emit_region(
        &self,
        region: &Profile2D,
        positions: &mut Vec<f32>,
        indices: &mut Vec<u32>,
    ) -> Result<()> {
        let holes: Vec<Vec<Point2<f64>>> =
            region.holes.iter().filter(|h| h.len() >= 3).cloned().collect();
        let rings: Vec<(&[Point2<f64>], Ring)> = std::iter::once((region.outer.as_slice(), Ring::Outer))
            .chain(holes.iter().map(|h| (h.as_slice(), Ring::Hole)))
            .collect();
        let ring_len: usize = rings.iter().map(|(r, _)| r.len()).sum();
        let ring_count = if self.full_circle { self.segments } else { self.segments + 1 };
        let base = (positions.len() / 3) as u32;
        positions.reserve(ring_count * ring_len * 3);

        // Rotate each profile vertex around the axis line: decompose
        // v = p - axis_location into its axis-parallel part and the
        // perpendicular part, and turn only the latter (Rodrigues).
        let k = self.axis_direction;
        for i in 0..ring_count {
            let t = if self.full_circle {
                std::f64::consts::TAU * i as f64 / self.segments as f64
            } else {
                self.angle * i as f64 / self.segments as f64
            };
            let (sin_t, cos_t) = t.sin_cos();
            for (ring, _) in &rings {
                for p2d in *ring {
                    let v = Point3::new(p2d.x, p2d.y, 0.0) - self.axis_location;
                    let v_par = k * v.dot(&k);
                    let v_perp = v - v_par;
                    let v_perp_rot = v_perp * cos_t + k.cross(&v_perp) * sin_t;
                    let p = self.axis_location + v_par + v_perp_rot;
                    positions.extend([p.x as f32, p.y as f32, p.z as f32]);
                }
            }
        }

        // Locally the revolution is an extrusion of the profile along ±z (its
        // plane normal): a point moves along `sense · (k × v).z`, the same sign
        // for the whole profile, which lies on one side of the axis. A full
        // revolution always steps by +TAU / segments.
        let turn = if self.full_circle { 1.0 } else { self.angle.signum() };
        let sense = turn
            * region
                .outer
                .iter()
                .map(|p| {
                    let v = Point3::new(p.x, p.y, 0.0) - self.axis_location;
                    k.x * v.y - k.y * v.x
                })
                .sum::<f64>();
        let along_z = sense >= 0.0;

        // Side quads between consecutive ring steps; the last step joins the
        // first only when the sweep closes (full revolution).
        let at = |step: usize, slot: usize| base + ((step % ring_count) * ring_len + slot) as u32;
        // An extrusion along +z keeps the right-hand order exactly when an
        // edge's right-hand side is outward; along -z it mirrors.
        let right_hand: Vec<bool> = rings
            .iter()
            .map(|(ring, kind)| outward_is_right_hand(ring, *kind) == along_z)
            .collect();
        for step in 0..self.segments {
            let mut start = 0usize;
            for ((ring, _), &right_hand) in rings.iter().zip(&right_hand) {
                let n = ring.len();
                for j in 0..n {
                    let jn = (j + 1) % n;
                    // A repeated vertex (the closing point many exporters
                    // write) is a zero-length edge: its zero-area "quad" would
                    // run both ways along the neighbouring arc edges. Skip it,
                    // as `create_side_walls` does.
                    if (ring[jn] - ring[j]).norm_squared() < 1e-20 {
                        continue;
                    }
                    let (a, b) = (at(step, start + j), at(step + 1, start + j));
                    let (c, d) = (at(step + 1, start + jn), at(step, start + jn));
                    if right_hand {
                        indices.extend([a, c, b, a, d, c]);
                    } else {
                        indices.extend([a, b, c, a, c, d]);
                    }
                }
                start += n;
            }
        }

        // End caps of a partial revolution, triangulated with the holes. The
        // start cap faces against the sweep, the end cap along it. Each
        // triangle is first wound counter-clockwise in the profile plane
        // (the fast-path and earcut orders differ), then flipped as needed.
        if !self.full_circle {
            let tri = triangulate_rings(&region.outer, &holes).map_err(|e| {
                Error::geometry(format!("Revolved profile cap triangulation failed: {e}"))
            })?;
            for t in tri.indices.chunks_exact(3) {
                let (p0, p1, p2) = (tri.points[t[0]], tri.points[t[1]], tri.points[t[2]]);
                let ccw = (p1 - p0).perp(&(p2 - p0)) >= 0.0;
                let (i0, i1, i2) = if ccw { (t[0], t[1], t[2]) } else { (t[0], t[2], t[1]) };
                for (step, faces_plus_z) in [(0, !along_z), (self.segments, along_z)] {
                    let (a, b, c) = (at(step, i0), at(step, i1), at(step, i2));
                    if faces_plus_z {
                        indices.extend([a, b, c]);
                    } else {
                        indices.extend([a, c, b]);
                    }
                }
            }
        }
        Ok(())
    }
}

impl Default for RevolvedAreaSolidProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}
