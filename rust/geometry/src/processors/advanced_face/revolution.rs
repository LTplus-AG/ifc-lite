// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcSurfaceOfRevolution tessellation by sweeping the generator profile.

use crate::{scale_segments, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::edge_loop::extract_edge_loop_points_for_bounds;
use super::polyline::sample_curve_polyline;
use super::surfaces::process_planar_face;

/// Tessellate an `IfcSurfaceOfRevolution` face by sweeping its profile curve
/// around the axis through the angular extent recovered from the face's edge
/// loops. Falls back to the planar boundary approximation when the profile or
/// axis can't be parsed.
pub(super) fn process_surface_of_revolution_face(
    face: &DecodedEntity,
    surface: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<(Vec<f32>, Vec<u32>)> {
    use nalgebra::Vector3;
    use std::f64::consts::TAU;

    let swept = surface
        .get(0)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten());
    // IfcSurfaceOfRevolution inherits Position (optional IfcAxis2Placement3D)
    // at slot 1 from IfcSweptSurface, and AxisPosition (IfcAxis1Placement) is
    // its own attribute at slot 2. The previous code read slot 1 and got the
    // (usually null) Position, leaving axis_origin at the (0,0,0) fallback
    // and collapsing the angular-extent calculation — the real cause of
    // issue #674's "stem in wrong direction" defect, not the radius/sign
    // collapse the earlier patch went after.
    let axis_pos = surface
        .get(2)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten());

    let (axis_origin, axis_dir) = if let Some(ap) = axis_pos {
        // IfcAxis1Placement: 0=Location, 1=Axis(Direction)
        let loc = ap
            .get(0)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|p| {
                let coords = p.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Point3::new(x, y, z))
            })
            .unwrap_or_else(|| Point3::new(0.0, 0.0, 0.0));
        let dir = ap
            .get(1)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|d| {
                let coords = d.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Vector3::new(x, y, z))
            })
            .and_then(|v| v.try_normalize(1e-12))
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        (loc, dir)
    } else {
        (Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0))
    };

    // Sample the generator profile curve.
    let profile_pts: Vec<Point3<f64>> = match swept {
        Some(s) if s.ifc_type.as_str().eq_ignore_ascii_case("IFCARBITRARYOPENPROFILEDEF") => {
            // Attribute 2 is the curve.
            if let Some(curve) = s.get(2).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
                sample_curve_polyline(&curve, decoder, quality)
            } else {
                Vec::new()
            }
        }
        Some(s) => sample_curve_polyline(&s, decoder, quality),
        None => Vec::new(),
    };

    if profile_pts.len() < 2 {
        return process_planar_face(face, decoder, quality);
    }

    // Build an orthonormal basis (axis_x, axis_y, axis_dir).
    let ref_dir = if axis_dir.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    let axis_x = (ref_dir - axis_dir * ref_dir.dot(&axis_dir))
        .try_normalize(1e-12)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
    let axis_y = axis_dir.cross(&axis_x);

    // Determine angular extent from the boundary edge points. We project each
    // boundary point's radial vector to a [0, TAU) angle, then find the
    // *largest gap* between sorted angles — the face occupies the complement.
    // This robustly handles faces that straddle the θ=π discontinuity (e.g.
    // a fillet at θ=−π/2..π) where naive min/max gives 3π/2 instead of π/2.
    let boundary = extract_edge_loop_points_for_bounds(face, decoder, quality);
    let (a_min, span) = if boundary.is_empty() {
        (0.0, TAU)
    } else {
        let mut angles: Vec<f64> = boundary
            .iter()
            .map(|p| {
                let v = p - axis_origin;
                let mut a = v.dot(&axis_y).atan2(v.dot(&axis_x));
                if a < 0.0 {
                    a += TAU;
                }
                a
            })
            .collect();
        angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        angles.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

        if angles.len() < 2 {
            (0.0, TAU)
        } else {
            let n = angles.len();
            let mut max_gap = 0.0;
            let mut max_gap_idx = 0usize;
            for i in 0..n {
                let next = if i + 1 < n { angles[i + 1] } else { angles[0] + TAU };
                let gap = next - angles[i];
                if gap > max_gap {
                    max_gap = gap;
                    max_gap_idx = i;
                }
            }
            // The face occupies the complement of the largest gap. If the
            // boundary samples are all on one side, the largest gap is on the
            // other side, and the face spans angles[(idx+1)%n] → angles[idx]+TAU.
            let start = angles[(max_gap_idx + 1) % n];
            let end_raw = angles[max_gap_idx];
            let end = if end_raw < start { end_raw + TAU } else { end_raw };
            let s = end - start;
            // If the gap is near zero or full, treat it as a full revolution.
            if s < 1e-6 || s > TAU - 1e-6 {
                (0.0, TAU)
            } else {
                (start, s)
            }
        }
    };
    let n_angle = scale_segments((span / (TAU / 36.0)).ceil() as usize, 4, 48, quality);
    let n_v = profile_pts.len();

    // Preserve the profile's (rx, ry) — issue #674: collapsing to radius
    // mirrored profiles on the −axis_x half to the +axis_x side, drifting
    // door-handle SoR bulbs 180° away from their bar.
    let local_profile: Vec<(f64, f64, f64)> = profile_pts
        .iter()
        .map(|p| {
            let r = p - axis_origin;
            (r.dot(&axis_x), r.dot(&axis_y), r.dot(&axis_dir))
        })
        .collect();

    // Per IFC 4.3 IfcSurfaceOfRevolution: S(u, v) = R(v) * (SweptCurve(u) -
    // AxisPosition.Location) + AxisPosition.Location, with v ∈ [0, 2π].
    // R(0) = identity, so the swept curve is its *natural* position at v=0.
    //
    // `(a_min, span)` here is the angular range of the FACE BOUNDARY POINTS
    // around the axis (computed by largest-gap detection above). For a
    // planar profile, every profile point shares the same natural angle
    // (the angle of the profile-plane around the axis), so the boundary
    // angle of a point at parameter v on the swept curve is
    //   boundary_angle = natural_angle + v
    // and the v-range we actually need to sweep is
    //   v ∈ [a_min − natural_angle, a_min − natural_angle + span].
    //
    // The previous fix dropped `a_min` and swept v ∈ [0, span] starting at
    // the natural position — correct only when a_min happens to coincide
    // with natural_angle. Door-handle bends (a_min = π/2, natural_angle =
    // π) regressed: the bulb pivoted to the opposite quadrant, producing
    // the "stem in wrong direction" defect issue #674 #674 reopened.
    // Pick the first profile point that's clearly off-axis. atan2(0, 0)
    // returns 0 even though the natural angle is undefined for a point
    // sitting on the rotation axis, so a profile that starts on-axis (a
    // common case for partial SoR faces where the profile touches the
    // axis at one end) would skew the entire sweep by a wrong constant
    // offset — Codex P1 on PR #799 follow-up.
    let natural_angle = local_profile
        .iter()
        .find(|&&(rx, ry, _)| rx.hypot(ry) > 1e-9)
        .map(|&(rx, ry, _)| ry.atan2(rx))
        .unwrap_or(0.0);

    let mut positions = Vec::with_capacity((n_angle + 1) * n_v * 3);
    for i in 0..=n_angle {
        let boundary_angle = a_min + span * (i as f64) / (n_angle as f64);
        let v = boundary_angle - natural_angle;
        let cos_v = v.cos();
        let sin_v = v.sin();
        for &(rx, ry, z) in &local_profile {
            let nrx = rx * cos_v - ry * sin_v;
            let nry = rx * sin_v + ry * cos_v;
            let world = axis_origin + axis_x * nrx + axis_y * nry + axis_dir * z;
            positions.push(world.x as f32);
            positions.push(world.y as f32);
            positions.push(world.z as f32);
        }
    }

    let mut indices = Vec::with_capacity(n_angle * (n_v - 1) * 6);
    for i in 0..n_angle {
        for j in 0..(n_v - 1) {
            let a = (i * n_v + j) as u32;
            let b = a + n_v as u32;
            let c = b + 1;
            let d = a + 1;
            indices.push(a);
            indices.push(b);
            indices.push(c);
            indices.push(a);
            indices.push(c);
            indices.push(d);
        }
    }

    if positions.is_empty() || indices.is_empty() {
        return process_planar_face(face, decoder, quality);
    }
    Ok((positions, indices))
}
