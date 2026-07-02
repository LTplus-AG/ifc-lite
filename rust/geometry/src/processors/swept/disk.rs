// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    profiles::ProfileProcessor, scale_segments, Error, Mesh, Point3, Result, TessellationQuality,
    Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

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
        quality: TessellationQuality,
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
        //   - IfcLine: linearly parameterised P(u) = Pnt + u·V, so StartParam/EndParam
        //     map straight onto the segment endpoints.
        // Other directrix types (IfcCircle, IfcBSplineCurve) have angle-/knot-based
        // parameterisations and fall back to the full sampler. An IfcTrimmedCurve
        // directrix is sampled over its own Trim1/Trim2 by get_curve_points (a
        // trimmed IfcLine retains full 3D); a file's redundant solid-level
        // StartParam/EndParam are then a no-op. Files using a raw circle/spline
        // directrix with explicit StartParam/EndParam still render the full curve —
        // flagged as a known limitation.
        // The lower-level trimmed samplers below don't take a `quality`
        // argument; set it on the profile processor so any arcs they sample
        // honour the requested detail level.
        self.profile_processor.set_tessellation_quality(quality);
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
        } else if has_trim && directrix.ifc_type == IfcType::IfcLine {
            // A bare IfcLine directrix is parameterised as P(u) = Pnt + u·V, so the
            // solid's StartParam/EndParam map straight onto the segment endpoints.
            // Without this the line samples over its unit range [0,1] only and the
            // swept extent collapses to the (tool-emitted) vector magnitude.
            self.profile_processor.get_line_points_3d(
                &directrix,
                decoder,
                start_param.unwrap_or(0.0),
                end_param.unwrap_or(1.0),
            )?
        } else {
            self.profile_processor
                .get_curve_points(&directrix, decoder, quality)?
        };

        if curve_points.len() < 2 {
            return Ok(Mesh::new()); // Not enough points
        }

        // Generate tube mesh by sweeping circle along curve
        // 24 segments around the circle at Medium; scaled by quality.
        let segments = scale_segments(24, 8, 96, quality);
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

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, local_bounds: None, local_to_world: None };

        // Ship smooth per-vertex normals, computed here in the directrix-local
        // frame where the coordinates are small (0..directrix-length) and so
        // precise. Without this the swept-disk mesh carried empty normals and
        // downstream consumers recomputed them from world-space f32 positions.
        // At a georef-scale placement (national-grid rebar sits ~6 km from the
        // origin) the edge differences `v1 - v0` cancel catastrophically — the
        // tube renders as a field of specular sparkles. A round tube wants
        // smooth (area-weighted) normals, unlike the crease-heavy revolved
        // solid which is flat-shaded. (#1164)
        crate::calculate_normals(&mut mesh);

        Ok(mesh)
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
