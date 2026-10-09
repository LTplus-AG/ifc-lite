// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcLinearPlacement resolution (#859): sample the basis curve at the authored distance.

use super::super::GeometryRouter;
use super::walk::PlacementWalk;
use crate::alignment::AlignmentCurve;
use crate::alignment_arc_length::ArcLengthMap;
use crate::profiles::ProfileProcessor;
use crate::{Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Resolve `IfcLinearPlacement` into a 4×4 transform: the authored
    /// `CartesianPosition` when the exporter baked one, otherwise by
    /// sampling the referenced basis curve at the authored `DistanceAlong`.
    /// Falls back gracefully when neither resolves; never panics.
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
    ) -> Result<PlacementWalk> {
        // PlacementRelTo (attr 0) composes the same way IfcLocalPlacement does,
        // truncation included: a parent walk cut short by the depth guard makes
        // this result depth-dependent too, so it must not be memoised. #3012
        let parent = match placement.get(0) {
            Some(parent_attr) if !parent_attr.is_null() => {
                match decoder.resolve_ref(parent_attr)? {
                    Some(p) => self.get_placement_transform_with_depth(&p, decoder, depth + 1)?,
                    None => PlacementWalk::complete(Matrix4::identity()),
                }
            }
            _ => PlacementWalk::complete(Matrix4::identity()),
        };

        // Prefer the authored CartesianPosition (attr 2) when the exporter
        // supplied one: it is the exact pre-computed placement. Sample the
        // curve only when no authored position exists (an `IfcGradientCurve`
        // is then evaluated with its vertical profile, see `gradient.rs`).
        let local = self
            .linear_placement_local(placement, decoder)
            .unwrap_or_else(Matrix4::identity);

        Ok(PlacementWalk { transform: parent.transform * local, truncated: parent.truncated })
    }

    /// The frame an `IfcLinearPlacement` adds to its `PlacementRelTo`: the
    /// authored `CartesianPosition`, else the sampled basis curve. File units.
    fn linear_placement_local(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        self.try_resolve_cartesian_position(placement, decoder)
            .or_else(|| self.try_resolve_axis2_placement_linear(placement, decoder))
    }

    /// Strict column-major local frame of an `IfcLinearPlacement` relative to
    /// its `PlacementRelTo`, exactly as rendering composes it, in file units.
    /// Unlike rendering there is no identity fallback: a writer baking this
    /// frame must refuse a placement it cannot resolve (#7335).
    pub fn resolve_linear_placement_local_strict(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        if placement.ifc_type != IfcType::IfcLinearPlacement {
            return Err(crate::Error::geometry(format!(
                "#{} is not an IfcLinearPlacement",
                placement.id
            )));
        }
        let local = self.linear_placement_local(placement, decoder).ok_or_else(|| {
            crate::Error::geometry(format!(
                "IfcLinearPlacement #{} cannot be resolved",
                placement.id
            ))
        })?;
        let mut result = [0.0; 16];
        result.copy_from_slice(local.as_slice());
        Ok(result)
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

        let (origin, tangent) = if basis_curve.ifc_type == IfcType::IfcGradientCurve {
            // `DistanceAlong` is 3D arc length. Use the same mapping and
            // authored-station rebase as sectioned solids and centerlines.
            let alignment = AlignmentCurve::parse(&basis_curve, decoder).ok().flatten()?;
            let station = ArcLengthMap::new(&alignment).horizontal_station(distance_along);
            let station = station.max(0.0).min(alignment.horizontal_length());
            let frame = alignment.evaluate(station);
            (frame.origin, frame.tangent)
        } else {
            // Other basis curves retain the existing polyline sampler.
            let samples = ProfileProcessor::new(IfcSchema::new())
                .get_curve_points(&basis_curve, decoder, TessellationQuality::Medium)
                .ok()
                .filter(|pts| pts.len() >= 2)?;
            sample_polyline_at_distance(&samples, distance_along)?
        };

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
    /// pre-baked `IfcAxis2Placement3D` carrying the exporter's own answer
    /// to the linear sampling. `None` when absent, null, or unparseable —
    /// the caller then samples the curve itself.
    fn try_resolve_cartesian_position(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        let cart_attr = placement.get(2)?;
        if cart_attr.is_null() {
            return None;
        }
        let cart = decoder.resolve_ref(cart_attr).ok().flatten()?;
        if cart.ifc_type != IfcType::IfcAxis2Placement3D {
            return None;
        }
        self.parse_axis2_placement_3d(&cart, decoder).ok()
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
#[path = "linear_tests.rs"]
mod tests;
