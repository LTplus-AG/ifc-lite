// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    profiles::ProfileProcessor, scale_segments, Error, Mesh, Point3, Result, TessellationQuality,
    Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

/// Two directrix samples closer than this (model units) are one point for
/// tangent purposes: their difference has no usable direction (#5191).
const TUBE_DEDUPE_EPS: f64 = 1e-9;

/// Gate every directrix before `build_tube_rmf` (#5191). A non-finite sample
/// is a load error: it would put NaN into every frame the RMF propagates to.
/// Fewer than two distinct samples (including all-coincident, which would
/// otherwise fabricate a flat disc from the end caps) sweeps nothing.
pub(crate) fn directrix_is_sweepable(points: &[Point3<f64>]) -> Result<bool> {
    if points.iter().any(|p| !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite())) {
        return Err(Error::geometry("swept solid directrix has a non-finite coordinate".to_string()));
    }
    Ok(points.iter().any(|p| (p - points[0]).norm() >= TUBE_DEDUPE_EPS))
}

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
///
/// Precondition: `curve_points` passed [`directrix_is_sweepable`].
pub(crate) fn build_tube_rmf(
    curve_points: &[Point3<f64>],
) -> (Vec<Vector3<f64>>, Vec<Vector3<f64>>, Vec<Vector3<f64>>) {
    let n = curve_points.len();
    let mut tangents = Vec::with_capacity(n);
    let mut perp1s = Vec::with_capacity(n);
    let mut perp2s = Vec::with_capacity(n);
    if n < 2 {
        return (tangents, perp1s, perp2s);
    }

    // #5191: a duplicate consecutive directrix point (e.g. two composite-curve
    // segments sharing an endpoint) makes the finite difference a zero vector,
    // whose `.normalize()` is NaN. Difference over the distinct points (`kept`)
    // and give each dropped duplicate its owner's tangent, so `tangents` stays
    // parallel to `curve_points`.
    let mut kept: Vec<Point3<f64>> = Vec::with_capacity(n);
    let mut owner: Vec<usize> = Vec::with_capacity(n);
    for &p in curve_points {
        if let Some(&last) = kept.last() {
            if (p - last).norm() < TUBE_DEDUPE_EPS {
                owner.push(kept.len() - 1);
                continue;
            }
        }
        kept.push(p);
        owner.push(kept.len() - 1);
    }

    let m = kept.len();
    let kept_tangents: Vec<Vector3<f64>> = if m < 2 {
        // Every sample coincides: no direction exists. `process` never gets
        // here (it meshes nothing); a fixed axis keeps the frame finite.
        vec![Vector3::new(1.0, 0.0, 0.0); m]
    } else {
        (0..m)
            .map(|k| {
                let t = if k == 0 {
                    kept[1] - kept[0]
                } else if k == m - 1 {
                    kept[k] - kept[k - 1]
                } else {
                    (kept[k + 1] - kept[k - 1]) / 2.0
                };
                // `kept` has no consecutive duplicates: the difference is non-zero.
                t.normalize()
            })
            .collect()
    };

    for &o in &owner {
        tangents.push(kept_tangents[o]);
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
        //
        // NaN-latching hazard (#5191): NaN comparisons are false, so a NaN
        // tangent also reads as "nearly parallel" and freezes a poisoned frame
        // for every later ring. Finite tangents are a precondition, held by the
        // dedupe above and by `directrix_is_sweepable` refusing non-finite points.
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

/// Mesh a circular (optionally annular) cross-section swept along
/// `curve_points`: one ring of `segments` vertices per sample on the outer
/// wall, a second ring per sample on the bore when `inner_radius` is set, and
/// caps at both ends (discs for a rod, annuli for a tube). Returns
/// `(positions, indices)`.
///
/// Every triangle is wound so its geometric normal points OUT of the material:
/// outer wall radially outward, bore wall radially inward (toward the axis),
/// start cap along `-t`, end cap along `+t`. The frame `(perp1, perp2, t)` is
/// right-handed (`perp2 = t x perp1`), so a ring vertex at angle `theta` sits
/// at `p + r(cos theta perp1 + sin theta perp2)` and CCW order in the
/// `(perp1, perp2)` plane faces `+t`. `swept_disk_side_walls_face_outward` in
/// `tests/swept_disk_winding_and_bore.rs` pins the sign.
fn build_tube(
    curve_points: &[Point3<f64>],
    radius: f64,
    inner_radius: Option<f64>,
    segments: usize,
) -> (Vec<f32>, Vec<u32>) {
    let n = curve_points.len();
    let seg = segments as u32;
    let walls = if inner_radius.is_some() { 2 } else { 1 };
    let mut positions: Vec<f32> = Vec::with_capacity(3 * (walls * n * segments + 2));
    let mut indices: Vec<u32> = Vec::with_capacity(6 * segments * walls * n);

    // Build a rotation-minimising frame across all sample points up-front.
    // (Per-iteration `up` selection caused frame flips at sharp bends.)
    let (_, perp1s, perp2s) = build_tube_rmf(curve_points);
    let unit_circle: Vec<(f64, f64)> = (0..segments)
        .map(|j| {
            let angle = 2.0 * std::f64::consts::PI * j as f64 / segments as f64;
            (angle.cos(), angle.sin())
        })
        .collect();

    let push_ring = |positions: &mut Vec<f32>, i: usize, r: f64| {
        let p = curve_points[i];
        for &(cos, sin) in &unit_circle {
            let vertex = p + (perp1s[i] * (r * cos) + perp2s[i] * (r * sin));
            positions.extend_from_slice(&[vertex.x as f32, vertex.y as f32, vertex.z as f32]);
        }
    };
    // Join ring `a` to ring `b`. `outward` is the outer wall's winding
    // (ring i to ring i+1, normal away from the axis); `false` is its mirror.
    // The bore wall and both annular caps (outer ring to bore ring) reuse it.
    let push_strip = |indices: &mut Vec<u32>, a: u32, b: u32, outward: bool| {
        for j in 0..seg {
            let j_next = (j + 1) % seg;
            if outward {
                indices.extend_from_slice(&[a + j, b + j_next, b + j]);
                indices.extend_from_slice(&[a + j, a + j_next, b + j_next]);
            } else {
                indices.extend_from_slice(&[a + j, b + j, b + j_next]);
                indices.extend_from_slice(&[a + j, b + j_next, a + j_next]);
            }
        }
    };

    let ring = |i: usize| (i * segments) as u32;
    for i in 0..n {
        push_ring(&mut positions, i, radius);
    }
    for i in 0..n - 1 {
        push_strip(&mut indices, ring(i), ring(i + 1), true);
    }

    match inner_radius {
        Some(inner) => {
            // Bore rings follow the outer rings, same sample order.
            let bore = |i: usize| ring(n + i);
            for i in 0..n {
                push_ring(&mut positions, i, inner);
            }
            for i in 0..n - 1 {
                push_strip(&mut indices, bore(i), bore(i + 1), false);
            }
            // Annular caps: start faces -t, end faces +t.
            push_strip(&mut indices, ring(0), bore(0), false);
            push_strip(&mut indices, ring(n - 1), bore(n - 1), true);
        }
        None => {
            // Disc caps fanned from the sample point on the axis.
            let (c0, c1) = (ring(n), ring(n) + 1);
            for p in [curve_points[0], curve_points[n - 1]] {
                positions.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
            }
            let (o0, o1) = (ring(0), ring(n - 1));
            for j in 0..seg {
                let jn = (j + 1) % seg;
                indices.extend_from_slice(&[c0, o0 + jn, o0 + j]); // start cap faces -t
                indices.extend_from_slice(&[c1, o1 + j, o1 + jn]); // end cap faces +t
            }
        }
    }

    (positions, indices)
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

        // InnerRadius (optional): a hollow tube's bore. Only a bore strictly
        // inside the outer wall bounds an annulus; a non-positive, non-finite,
        // or at-or-past-`radius` value cannot, and the sweep meshes as a rod.
        let inner_radius = entity
            .get_float(2)
            .filter(|&r| r.is_finite() && r > 0.0 && r < radius);

        // StartParam / EndParam (optional IfcParameterValue), in the directrix's
        // own IFC parametrisation. Without honoring these, files that intend e.g.
        // only the first leg to be swept render every segment — the common rebar
        // case where a 2 m bar reads as 12 m with hooks unfolded.
        let start_param = entity.get_float(3);
        let end_param = entity.get_float(4);

        let directrix = decoder
            .resolve_ref(directrix_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Directrix".to_string()))?;
        let curve_points = self.profile_processor.get_directrix_points(
            &directrix,
            decoder,
            start_param,
            end_param,
            quality,
        )?;

        if !directrix_is_sweepable(&curve_points)? {
            return Ok(Mesh::new());
        }

        // Generate tube mesh by sweeping circle along curve
        // 24 segments around the circle at Medium; scaled by quality.
        let segments = scale_segments(24, 8, 96, quality);
        let (positions, indices) = build_tube(&curve_points, radius, inner_radius, segments);

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
            origin: [0.0; 3],
            welded_in_object_frame: false,
            plane_tags: None,
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
#[path = "disk_tests.rs"]
mod tests;
