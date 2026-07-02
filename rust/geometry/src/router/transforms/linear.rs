// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcLinearPlacement resolution (#859): sample the basis curve at the authored distance.

use super::super::GeometryRouter;
use crate::profiles::ProfileProcessor;
use crate::{Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Resolve `IfcLinearPlacement` into a 4×4 transform by sampling the
    /// referenced basis curve at the authored `DistanceAlong`. Falls back
    /// gracefully when the curve cannot be sampled or the attribute layout
    /// is malformed; never panics.
    ///
    /// Output transform: the origin is the curve sample plus
    /// `lateral*right + vertical*up + longitudinal*tangent`. Basis is
    /// (tangent, right, up) with `up = (0, 0, 1)` and `right = up cross tangent`.
    /// When the tangent is (nearly) vertical the frame degenerates and falls
    /// back to identity rotation about the sampled origin.
    pub(super) fn resolve_linear_placement_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<Matrix4<f64>> {
        // PlacementRelTo (attr 0) composes the same way IfcLocalPlacement does.
        let parent_transform = if let Some(parent_attr) = placement.get(0) {
            if !parent_attr.is_null() {
                if let Some(parent) = decoder.resolve_ref(parent_attr)? {
                    self.get_placement_transform_with_depth(&parent, decoder, depth + 1)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // RelativePlacement (attr 1) → IfcAxis2PlacementLinear with the curve
        // sampling info. If we can't reach a valid sample, prefer the
        // pre-baked CartesianPosition (attr 2) over identity so the element
        // at least lands somewhere sensible.
        let local = match self.try_resolve_axis2_placement_linear(placement, decoder) {
            Some(m) => m,
            None => self.try_resolve_cartesian_fallback(placement, decoder),
        };

        Ok(parent_transform * local)
    }

    /// Decode `IfcLinearPlacement.RelativePlacement` → sample the basis
    /// curve → build the local transform. Returns `None` if any required
    /// piece is missing so the caller can fall back to `CartesianPosition`.
    fn try_resolve_axis2_placement_linear(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        let rel_attr = placement.get(1)?;
        if rel_attr.is_null() {
            return None;
        }
        let rel = decoder.resolve_ref(rel_attr).ok().flatten()?;
        if rel.ifc_type != IfcType::IfcAxis2PlacementLinear {
            return None;
        }

        // IfcAxis2PlacementLinear: 0 Location (IfcPointByDistanceExpression),
        //                          1 Axis (IfcDirection, optional, default up),
        //                          2 RefDirection (IfcDirection, optional).
        let location_attr = rel.get(0)?;
        if location_attr.is_null() {
            return None;
        }
        let location = decoder.resolve_ref(location_attr).ok().flatten()?;
        if location.ifc_type != IfcType::IfcPointByDistanceExpression {
            return None;
        }

        // IfcPointByDistanceExpression: 0 DistanceAlong (IfcLengthMeasure),
        //                               1 OffsetLateral (optional),
        //                               2 OffsetVertical (optional),
        //                               3 OffsetLongitudinal (optional),
        //                               4 BasisCurve (IfcCurve).
        let distance_along = location.get_float(0)?;
        let offset_lateral = location.get_float(1).unwrap_or(0.0);
        let offset_vertical = location.get_float(2).unwrap_or(0.0);
        let offset_longitudinal = location.get_float(3).unwrap_or(0.0);

        let basis_attr = location.get(4)?;
        if basis_attr.is_null() {
            return None;
        }
        let basis_curve = decoder.resolve_ref(basis_attr).ok().flatten()?;

        // Sample the basis curve into a polyline. `ProfileProcessor::get_curve_points`
        // already handles IfcCompositeCurve, IfcPolyline, IfcGradientCurve via its
        // composite-curve walk, IfcTrimmedCurve, IfcIndexedPolyCurve, etc. — every
        // curve type the alignment authors in #859's fixture eventually reduce to.
        let processor = ProfileProcessor::new(IfcSchema::new());
        let samples = processor
            .get_curve_points(&basis_curve, decoder, TessellationQuality::Medium)
            .ok()
            .filter(|pts| pts.len() >= 2)?;

        let (origin, tangent) = sample_polyline_at_distance(&samples, distance_along)?;

        // Build the curve-aligned frame with world-up. Railway alignments
        // are near-horizontal so this is well-conditioned; in the
        // pathological vertical-tangent case we keep an identity rotation
        // at the sampled origin rather than emit NaN axes.
        let world_up = Vector3::new(0.0, 0.0, 1.0);
        let tangent_horiz_norm =
            (tangent - world_up * tangent.dot(&world_up)).norm();
        let (x_axis, y_axis, z_axis) = if tangent_horiz_norm > 1e-9 {
            let x = tangent.normalize();
            let y = world_up.cross(&x).normalize();
            let z = x.cross(&y).normalize();
            (x, y, z)
        } else {
            (
                Vector3::new(1.0, 0.0, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
                Vector3::new(0.0, 0.0, 1.0),
            )
        };

        let position = origin.coords
            + x_axis * offset_longitudinal
            + y_axis * offset_lateral
            + z_axis * offset_vertical;

        let mut m = Matrix4::<f64>::identity();
        m.fixed_view_mut::<3, 1>(0, 0).copy_from(&x_axis);
        m.fixed_view_mut::<3, 1>(0, 1).copy_from(&y_axis);
        m.fixed_view_mut::<3, 1>(0, 2).copy_from(&z_axis);
        m[(0, 3)] = position.x;
        m[(1, 3)] = position.y;
        m[(2, 3)] = position.z;
        Some(m)
    }

    /// `IfcLinearPlacement.CartesianPosition` (attr 2) is an optional
    /// pre-baked `IfcAxis2Placement3D` that authors are encouraged to
    /// supply for tools that cannot resolve the linear sampling. Use it
    /// when our sampler can't reach a result; identity otherwise.
    fn try_resolve_cartesian_fallback(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Matrix4<f64> {
        let Some(cart_attr) = placement.get(2) else {
            return Matrix4::identity();
        };
        if cart_attr.is_null() {
            return Matrix4::identity();
        }
        let Ok(Some(cart)) = decoder.resolve_ref(cart_attr) else {
            return Matrix4::identity();
        };
        if cart.ifc_type != IfcType::IfcAxis2Placement3D {
            return Matrix4::identity();
        }
        self.parse_axis2_placement_3d(&cart, decoder)
            .unwrap_or_else(|_| Matrix4::identity())
    }
}

/// Walk a polyline-sampled curve and interpolate to a target arc length.
///
/// Returns the 3D position at `distance` along the polyline plus the unit
/// tangent of the segment containing it. The caller is expected to pass a
/// densely-sampled polyline from
/// [`ProfileProcessor::get_curve_points`][crate::profiles::ProfileProcessor::get_curve_points]
/// — the precision of the result is bounded by the sampler's spacing.
///
/// Behaviour at the extremes:
/// - `distance <= 0`: returns the first sample with the first segment's tangent.
/// - `distance >= total length`: returns the last sample with the last segment's tangent.
/// - Empty / single-sample polyline: `None` (the caller should fall back).
fn sample_polyline_at_distance(
    samples: &[Point3<f64>],
    distance: f64,
) -> Option<(Point3<f64>, Vector3<f64>)> {
    if samples.len() < 2 {
        return None;
    }

    if distance <= 0.0 {
        let tangent = (samples[1] - samples[0])
            .try_normalize(1e-12)
            .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
        return Some((samples[0], tangent));
    }

    let mut acc = 0.0;
    for window in samples.windows(2) {
        let a = window[0];
        let b = window[1];
        let seg = b - a;
        let len = seg.norm();
        if len < 1e-12 {
            continue;
        }
        if acc + len >= distance {
            let t = ((distance - acc) / len).clamp(0.0, 1.0);
            let position = a + seg * t;
            let tangent = (seg / len)
                .try_normalize(1e-12)
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
            return Some((position, tangent));
        }
        acc += len;
    }

    // distance past the end of the curve — clamp to last sample, last segment tangent.
    let last = samples[samples.len() - 1];
    let prev = samples[samples.len() - 2];
    let tangent = (last - prev)
        .try_normalize(1e-12)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
    Some((last, tangent))
}

#[cfg(test)]
mod sample_polyline_tests {
    use super::*;

    #[test]
    fn samples_at_start_middle_end() {
        // Straight line along +X from (0,0,0) to (10,0,0) in 1 m segments.
        let samples: Vec<Point3<f64>> = (0..=10)
            .map(|i| Point3::new(i as f64, 0.0, 0.0))
            .collect();

        let (p0, t0) = sample_polyline_at_distance(&samples, 0.0).unwrap();
        assert!((p0 - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t0 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p5, t5) = sample_polyline_at_distance(&samples, 5.0).unwrap();
        assert!((p5 - Point3::new(5.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t5 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p10, _) = sample_polyline_at_distance(&samples, 10.0).unwrap();
        assert!((p10 - Point3::new(10.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn clamps_past_end() {
        let samples = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(3.0, 4.0, 0.0), // length 5
        ];
        let (p, t) = sample_polyline_at_distance(&samples, 99.0).unwrap();
        assert!((p - Point3::new(3.0, 4.0, 0.0)).norm() < 1e-9);
        assert!((t.norm() - 1.0).abs() < 1e-9, "tangent must be unit");
    }

    #[test]
    fn empty_returns_none() {
        let none = sample_polyline_at_distance(&[], 0.0);
        assert!(none.is_none());
        let single = sample_polyline_at_distance(&[Point3::new(0.0, 0.0, 0.0)], 0.0);
        assert!(single.is_none());
    }
}
