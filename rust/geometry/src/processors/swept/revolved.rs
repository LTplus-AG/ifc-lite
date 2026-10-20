// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::extrusion_generic::{outward_is_right_hand, Ring};
use crate::profile::{triangulate_rings, Profile2D};
use crate::{
    profiles::ProfileProcessor, Error, Mesh, Point2,
    Point3, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

#[path = "revolved_plan.rs"]
mod plan;

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

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<plan::RevolvedPlan> {
        plan::lower(entity, decoder, quality, &self.profile_processor)
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
        self.lower(entity, decoder, quality)?.evaluate()
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcRevolvedAreaSolid]
    }
}

/// One `IfcRevolvedAreaSolid` sweep, in Position-local coordinates: the
/// profile lies in the xy plane and turns about the line through
/// `axis_location` along unit `axis_direction`.
#[derive(Debug, Clone)]
pub(crate) struct Revolution {
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
