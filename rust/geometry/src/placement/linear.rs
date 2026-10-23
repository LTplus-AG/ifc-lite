// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcLinearPlacement resolution (#859): sample the basis curve at the authored distance.

use super::{missing, sampled, unsupported, Axis2Placement, PlacementResult};
use crate::alignment::AlignmentCurve;
use crate::math::tol;
use crate::alignment_arc_length::ArcLengthMap;
use crate::axis_projection::linear_placement_axes;
use crate::profiles::ProfileProcessor;
use crate::{Point3, TessellationQuality, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcSchema, IfcType, SchemaVersion};
use nalgebra::Matrix4;

// Output transform of a sampled placement: the origin is the curve sample plus
// `lateral*right + vertical*up + longitudinal*tangent`. Basis is
// (tangent, right, up) with `up = (0, 0, 1)` and `right = up cross tangent`.
// When the tangent is (nearly) vertical the frame degenerates and falls back
// to identity rotation about the sampled origin. The authored
// `CartesianPosition` wins when the exporter supplied one: it is the
// exact pre-computed placement; an `IfcGradientCurve` is evaluated with its
// vertical profile otherwise (see `gradient.rs`).

/// Decode a position using the same schema layout in rendering and validation.
fn position(
    placement: &DecodedEntity,
    field: slot::SchemaSlot<slot::kind::Ref>,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<DecodedEntity>> {
    let Some(at) = decoder.slot_or(field, SchemaVersion::Ifc4x3) else { return Ok(None) };
    Ok(decoder.resolve_optional(placement, at.index())?)
}

/// Source admission, without sampling a basis curve. Keep analytic preflight's
/// completeness/type rules even when a renderer could choose another fallback
/// (#7779 P4). Actual curve resolvability remains the consuming resolver's job.
pub(super) fn validate_source(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<()> {
    let relative = position(placement, slot::IfcLinearPlacement::RELATIVE_PLACEMENT, decoder)?;
    let cartesian = position(placement, slot::IfcLinearPlacement::CARTESIAN_POSITION, decoder)?;
    if relative.is_none() && cartesian.is_none() {
        return Err(missing(decoder, placement.id, "RelativePlacement or CartesianPosition"));
    }
    if let Some(relative) = relative {
        if relative.ifc_type != IfcType::IfcAxis2PlacementLinear {
            return Err(unsupported(decoder, relative.id, relative.ifc_type));
        }
    }
    if let Some(cartesian) = cartesian {
        Axis2Placement::read_3d(&cartesian, decoder)?;
    }
    Ok(())
}

/// The frame an `IfcLinearPlacement` adds to its `PlacementRelTo`: the
/// authored `CartesianPosition`, else the sampled basis curve. File units.
pub(crate) fn local_frame(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Matrix4<f64>> {
    // Authored CartesianPosition is authoritative when present. A malformed
    // authored frame must not silently fall through to a different curve frame.
    if let Some(cart) = position(placement, slot::IfcLinearPlacement::CARTESIAN_POSITION, decoder)? {
        return Axis2Placement::read_3d(&cart, decoder).map(|a| a.matrix());
    }
    try_resolve_axis2_placement_linear(placement, decoder)
}

/// Strict column-major local frame of an `IfcLinearPlacement` relative to
/// its `PlacementRelTo`, exactly as rendering composes it, in file units.
/// A writer baking this frame uses the same refusal contract as rendering
/// (#7335, #7779/7877).
pub(crate) fn local_strict(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> crate::Result<[f64; 16]> {
    if placement.ifc_type != IfcType::IfcLinearPlacement {
        return Err(crate::Error::geometry(format!(
            "#{} is not an IfcLinearPlacement",
            placement.id
        )));
    }
    let frame = local_frame(placement, decoder)?;
    Ok(crate::math::mat4::col_major_array(&frame))
}

/// Decode `IfcLinearPlacement.RelativePlacement` → sample the basis
/// curve → build the local transform. Unreadable required pieces refuse the
/// frame. Authored CartesianPosition
/// is selected before sampling.
fn try_resolve_axis2_placement_linear(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Matrix4<f64>> {
    // slot_or follows the declared layout when the entity exists there. Only
    // mislabelled schemas predating the entity use the established IFC4X3 layout.
    let rel = position(placement, slot::IfcLinearPlacement::RELATIVE_PLACEMENT, decoder)?
        .ok_or_else(|| missing(decoder, placement.id, "a resolvable CartesianPosition or RelativePlacement"))?;
    if rel.ifc_type != IfcType::IfcAxis2PlacementLinear {
        return Err(unsupported(decoder, rel.id, rel.ifc_type));
    }
    let location = decoder.resolve_optional(&rel, slot::IfcAxis2PlacementLinear::LOCATION.index())?
        .ok_or_else(|| missing(decoder, rel.id, "Location"))?;
    if location.ifc_type != IfcType::IfcPointByDistanceExpression {
        return Err(unsupported(decoder, location.id, location.ifc_type));
    }

    // IfcPointByDistanceExpression: 0 DistanceAlong (IfcLengthMeasure),
    //                               1 OffsetLateral (optional),
    //                               2 OffsetVertical (optional),
    //                               3 OffsetLongitudinal (optional),
    //                               4 BasisCurve (IfcCurve).
    let distance_along = location.attr(slot::IfcPointByDistanceExpression::DISTANCE_ALONG)
        .and_then(|v| v.as_float()).filter(|v| v.is_finite())
        .ok_or_else(|| missing(decoder, location.id, "a readable DistanceAlong"))?;
    let offset_lateral = optional_offset(&location, slot::IfcPointByDistanceExpression::OFFSET_LATERAL.index())
        .ok_or_else(|| missing(decoder, location.id, "a readable OffsetLateral"))?;
    let offset_vertical = optional_offset(&location, slot::IfcPointByDistanceExpression::OFFSET_VERTICAL.index())
        .ok_or_else(|| missing(decoder, location.id, "a readable OffsetVertical"))?;
    let offset_longitudinal = optional_offset(&location, slot::IfcPointByDistanceExpression::OFFSET_LONGITUDINAL.index())
        .ok_or_else(|| missing(decoder, location.id, "a readable OffsetLongitudinal"))?;

    let basis_curve = decoder.resolve_optional(&location, slot::IfcPointByDistanceExpression::BASIS_CURVE.index())?
        .ok_or_else(|| missing(decoder, location.id, "BasisCurve"))?;

    let (origin, tangent) = sample_basis(&basis_curve, distance_along, decoder)?
        .ok_or_else(|| missing(decoder, placement.id, "a resolvable CartesianPosition or RelativePlacement"))?;

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

    // IFC4X3 `IfcAxis2PlacementLinear.Axis` / `RefDirection` (attrs 1, 2)
    // orient the frame, expressed in the curve frame above (#7791). The
    // offsets already used the unrotated curve frame. Unreadable or
    // degenerate directions leave the placement unresolvable.
    let (axis, ref_direction) = (
        read_linear_direction(&rel, slot::IfcAxis2PlacementLinear::AXIS.index(), decoder)?,
        read_linear_direction(&rel, slot::IfcAxis2PlacementLinear::REF_DIRECTION.index(), decoder)?,
    );
    let [x_axis, y_axis, z_axis] = if axis.is_some() || ref_direction.is_some() {
        linear_placement_axes([x_axis, y_axis, z_axis], axis, ref_direction)
            .ok_or_else(|| missing(decoder, rel.id, "a usable linear orientation"))?
    } else {
        [x_axis, y_axis, z_axis]
    };

    let mut m = Matrix4::<f64>::identity();
    m.fixed_view_mut::<3, 1>(0, 0).copy_from(&x_axis);
    m.fixed_view_mut::<3, 1>(0, 1).copy_from(&y_axis);
    m.fixed_view_mut::<3, 1>(0, 2).copy_from(&z_axis);
    m[(0, 3)] = position.x;
    m[(1, 3)] = position.y;
    m[(2, 3)] = position.z;
    Ok(m)
}

/// Existing gradient/polyline sampling, before local orientation and offsets.
fn sample_basis(
    basis_curve: &DecodedEntity,
    distance_along: f64,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<(Point3<f64>, Vector3<f64>)>> {
    if basis_curve.ifc_type == IfcType::IfcGradientCurve {
        // DistanceAlong is 3D arc length; keep the existing station rebase.
        let Some(alignment) = sampled(AlignmentCurve::parse(basis_curve, decoder))?.flatten() else {
            return Ok(None);
        };
        let station = ArcLengthMap::new(&alignment).horizontal_station(distance_along);
        let station = station.max(0.0).min(alignment.horizontal_length());
        let frame = alignment.evaluate(station);
        Ok(Some((frame.origin, frame.tangent)))
    } else {
        let Some(samples) = sampled(ProfileProcessor::new(IfcSchema::new())
            .get_curve_points(basis_curve, decoder, TessellationQuality::Medium))?
            .filter(|pts| pts.len() >= 2) else {
                return Ok(None);
            };
        Ok(sample_polyline_at_distance(&samples, distance_along))
    }
}

/// Null/absent offsets default to zero; authored unreadable or nonfinite values
/// must not be silently replaced with zero (#7779/7877).
fn optional_offset(entity: &DecodedEntity, index: usize) -> Option<f64> {
    match entity.get(index) {
        None | Some(ifc_lite_core::AttributeValue::Null | ifc_lite_core::AttributeValue::Derived) => Some(0.0),
        Some(value) => value.as_float().filter(|v| v.is_finite()),
    }
}

/// An optional `IfcAxis2PlacementLinear` direction (`Axis`, `RefDirection`):
/// `Ok(None)` when absent or `$`, `Ok(Some(unit))` when authored, and
/// a refusal when it is not a readable non-zero `IfcDirection`.
fn read_linear_direction(
    rel: &DecodedEntity,
    slot: usize,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<Vector3<f64>>> {
    match decoder.direction3_at(rel, slot)? {
        None => Ok(None),
        Some(ratios) => Vector3::from(ratios).try_normalize(tol::DIRECTION_MIN_LEN)
            .map(Some).ok_or_else(|| missing(decoder, rel.id, "a non-zero linear direction")),
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
pub(super) fn sample_polyline_at_distance(
    samples: &[Point3<f64>],
    distance: f64,
) -> Option<(Point3<f64>, Vector3<f64>)> {
    if samples.len() < 2 {
        return None;
    }

    if distance <= 0.0 {
        let tangent = (samples[1] - samples[0])
            .try_normalize(tol::DIRECTION_MIN_LEN)
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
                .try_normalize(tol::DIRECTION_MIN_LEN)
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
            return Some((position, tangent));
        }
        acc += len;
    }

    // distance past the end of the curve — clamp to last sample, last segment tangent.
    let last = samples[samples.len() - 1];
    let prev = samples[samples.len() - 2];
    let tangent = (last - prev)
        .try_normalize(tol::DIRECTION_MIN_LEN)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
    Some((last, tangent))
}
