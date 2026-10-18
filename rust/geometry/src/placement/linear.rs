// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcLinearPlacement resolution (#859): sample the basis curve at the authored distance.

use super::{missing, unsupported, Axis2Placement, PlacementResult};
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
// `CartesianPosition` (attr 2) wins when the exporter supplied one: it is the
// exact pre-computed placement; an `IfcGradientCurve` is evaluated with its
// vertical profile otherwise (see `gradient.rs`).

/// Resolve one schema-dependent position slot in the canonical reader. The
/// strict validator and the two renderer alternatives share this admission.
fn position(
    placement: &DecodedEntity,
    field: slot::SchemaSlot<slot::kind::Ref>,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<DecodedEntity>> {
    // This support base predates slot_or and keeps schema_version private.
    // Probe the entity's inherited attribute through the public canonical
    // registry: an absent entity keeps the IFC4X3 compatibility layout, while
    // an absent RelativePlacement on declared IFC4X1/4X2 must remain absent.
    let at = if decoder.attribute_index("IfcLinearPlacement", "PlacementRelTo").is_none() {
        field.at(SchemaVersion::Ifc4x3)
    } else { decoder.slot(field) };
    let Some(at) = at else { return Ok(None) };
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
) -> Option<Matrix4<f64>> {
    try_resolve_cartesian_position(placement, decoder)
        .or_else(|| try_resolve_axis2_placement_linear(placement, decoder))
}

/// Strict column-major local frame of an `IfcLinearPlacement` relative to
/// its `PlacementRelTo`, exactly as rendering composes it, in file units.
/// Unlike rendering there is no identity fallback: a writer baking this
/// frame must refuse a placement it cannot resolve (#7335).
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
    let frame = local_frame(placement, decoder).ok_or_else(|| {
        crate::Error::geometry(format!(
            "IfcLinearPlacement #{} cannot be resolved",
            placement.id
        ))
    })?;
    Ok(crate::math::mat4::col_major_array(&frame))
}

/// Decode `IfcLinearPlacement.RelativePlacement` → sample the basis
/// curve → build the local transform. Returns `None` if any required
/// piece is missing so the caller can fall back to `CartesianPosition`.
fn try_resolve_axis2_placement_linear(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<Matrix4<f64>> {
    // IFC4X3 position of RelativePlacement; IFC4X1/4X2 have no such
    // attribute (their slot 1 is `Distance`), so those placements are
    // resolved from `CartesianPosition` alone. A file whose declared schema
    // predates `IfcLinearPlacement` (IFC2X3, IFC4) is a mislabelled IFC4X3
    // export and keeps being read with the IFC4X3 layout.
    let rel = position(placement, slot::IfcLinearPlacement::RELATIVE_PLACEMENT, decoder).ok().flatten()?;
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

    // IFC4X3 `IfcAxis2PlacementLinear.Axis` / `RefDirection` (attrs 1, 2)
    // orient the frame, expressed in the curve frame above (#7791). The
    // offsets already used the unrotated curve frame. Unreadable or
    // degenerate directions leave the placement unresolvable.
    let (axis, ref_direction) = (
        read_linear_direction(&rel, 1, decoder)?,
        read_linear_direction(&rel, 2, decoder)?,
    );
    let [x_axis, y_axis, z_axis] = if axis.is_some() || ref_direction.is_some() {
        linear_placement_axes([x_axis, y_axis, z_axis], axis, ref_direction)?
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
    Some(m)
}

/// An optional `IfcAxis2PlacementLinear` direction (`Axis`, `RefDirection`):
/// `Some(None)` when absent or `$`, `Some(Some(unit))` when authored, and
/// `None` (unresolvable) when it is not a readable non-zero `IfcDirection`.
fn read_linear_direction(
    rel: &DecodedEntity,
    slot: usize,
    decoder: &mut EntityDecoder,
) -> Option<Option<Vector3<f64>>> {
    let attr = match rel.get(slot) {
        Some(attr) if !attr.is_null() => attr,
        _ => return Some(None),
    };
    let v = Vector3::from(decoder.direction3(attr.as_entity_ref()?).ok()?);
    v.try_normalize(tol::DIRECTION_MIN_LEN).map(Some)
}

/// `IfcLinearPlacement.CartesianPosition` (attr 2) is an optional
/// pre-baked `IfcAxis2Placement3D` carrying the exporter's own answer
/// to the linear sampling. `None` when absent, null, or unparseable —
/// the caller then samples the curve itself.
fn try_resolve_cartesian_position(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<Matrix4<f64>> {
    let cart = position(placement, slot::IfcLinearPlacement::CARTESIAN_POSITION, decoder).ok().flatten()?;
    if cart.ifc_type != IfcType::IfcAxis2Placement3D {
        return None;
    }
    Axis2Placement::read_3d(&cart, decoder).ok().map(|a| a.matrix())
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
