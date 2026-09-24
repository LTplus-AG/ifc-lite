// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::AnalyticCurveSegment as Segment;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::TAU;

pub(super) fn invalid(message: &str) -> Error {
    Error::geometry(message.to_string())
}

pub(super) fn resolve(
    attr: Option<&AttributeValue>,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity> {
    let attr = attr.ok_or_else(|| invalid("missing curve reference"))?;
    decoder
        .resolve_ref(attr)?
        .ok_or_else(|| invalid("curve reference cannot be resolved"))
}

pub(super) fn point_values(values: &[AttributeValue]) -> Result<[f64; 3]> {
    if values.len() < 2 {
        return Err(invalid("Cartesian point has fewer than two coordinates"));
    }
    let mut point = [0.0; 3];
    for i in 0..values.len().min(3) {
        point[i] = values[i]
            .as_float()
            .ok_or_else(|| invalid("invalid Cartesian coordinate"))?;
        if !point[i].is_finite() {
            return Err(invalid("non-finite Cartesian coordinate"));
        }
    }
    Ok(point)
}

pub(super) fn point_from_ref(
    attr: &AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<[f64; 3]> {
    let point = resolve(Some(attr), decoder)?;
    point_values(
        point
            .get_list(0)
            .ok_or_else(|| invalid("CartesianPoint missing Coordinates"))?,
    )
}

pub(super) fn vector_from_ref(
    attr: &AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<Vector3<f64>> {
    let direction = resolve(Some(attr), decoder)?;
    let p = point_values(
        direction
            .get_list(0)
            .ok_or_else(|| invalid("Direction missing DirectionRatios"))?,
    )?;
    Vector3::from(p)
        .try_normalize(1e-12)
        .ok_or_else(|| invalid("invalid zero Direction"))
}

pub(super) fn line_basis(
    line: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<([f64; 3], [f64; 3])> {
    let origin = point_from_ref(
        line.get(0).ok_or_else(|| invalid("Line missing Pnt"))?,
        decoder,
    )?;
    let vector = resolve(line.get(1), decoder)?;
    let direction = vector_from_ref(
        vector
            .get(0)
            .ok_or_else(|| invalid("Vector missing Orientation"))?,
        decoder,
    )?;
    let magnitude = vector
        .get_float(1)
        .ok_or_else(|| invalid("Vector missing Magnitude"))?;
    if !magnitude.is_finite() {
        return Err(invalid("non-finite vector magnitude"));
    }
    Ok((origin, (direction * magnitude).into()))
}

pub(super) fn line(
    line: &DecodedEntity,
    decoder: &mut EntityDecoder,
    a: f64,
    b: f64,
) -> Result<Segment> {
    let (origin, v) = line_basis(line, decoder)?;
    let p = |t: f64| std::array::from_fn(|i| origin[i] + v[i] * t);
    Ok(Segment::Line {
        start: p(a),
        end: p(b),
    })
}

pub(super) fn trim_point(
    attr: Option<&AttributeValue>,
    origin: [f64; 3],
    v: [f64; 3],
    cartesian: bool,
    decoder: &mut EntityDecoder,
) -> Result<Option<[f64; 3]>> {
    let Some(values) = attr.and_then(AttributeValue::as_list) else {
        return Ok(None);
    };
    let mut param = None;
    let mut point = None;
    for value in values {
        if value.as_entity_ref().is_some() {
            point = Some(point_from_ref(value, decoder)?);
        } else if let Some(typed) = value.as_list() {
            if typed.first().and_then(AttributeValue::as_string) == Some("IFCPARAMETERVALUE") {
                param = typed.get(1).and_then(AttributeValue::as_float);
            }
        } else {
            param = value.as_float().or(param);
        }
    }
    let from_param = param.map(|t| std::array::from_fn(|i| origin[i] + v[i] * t));
    Ok(if cartesian {
        point.or(from_param)
    } else {
        from_param.or(point)
    })
}

pub(super) fn circle_basis(
    circle: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<([f64; 3], [f64; 3], [f64; 3], [f64; 3], f64)> {
    let placement = resolve(circle.get(0), decoder)?;
    let center = point_from_ref(
        placement
            .get(0)
            .ok_or_else(|| invalid("Placement missing Location"))?,
        decoder,
    )?;
    let radius = circle
        .get_float(1)
        .filter(|r| r.is_finite() && *r > 0.0)
        .ok_or_else(|| invalid("Circle has invalid Radius"))?;
    let (normal, x, y) = if placement.ifc_type == IfcType::IfcAxis2Placement3D {
        let frame = crate::transform::parse_axis2_placement_3d(&placement, decoder)?;
        (
            [frame[(0, 2)], frame[(1, 2)], frame[(2, 2)]],
            [frame[(0, 0)], frame[(1, 0)], frame[(2, 0)]],
            [frame[(0, 1)], frame[(1, 1)], frame[(2, 1)]],
        )
    } else if placement.ifc_type == IfcType::IfcAxis2Placement2D {
        let x = placement
            .get(1)
            .filter(|a| !a.is_null())
            .map(|a| vector_from_ref(a, decoder))
            .transpose()?
            .unwrap_or(Vector3::x());
        let x = Vector3::new(x.x, x.y, 0.0)
            .try_normalize(1e-12)
            .ok_or_else(|| invalid("invalid planar circle RefDirection"))?;
        ([0.0, 0.0, 1.0], x.into(), [-x.y, x.x, 0.0])
    } else {
        return Err(invalid("Circle Position is not an Axis2Placement"));
    };
    Ok((center, normal, x, y, radius))
}

pub(super) fn trim_angle(
    attr: Option<&AttributeValue>,
    center: [f64; 3],
    x: [f64; 3],
    y: [f64; 3],
    cartesian: bool,
    decoder: &mut EntityDecoder,
) -> Result<Option<f64>> {
    let Some(values) = attr.and_then(AttributeValue::as_list) else {
        return Ok(None);
    };
    let mut param = None;
    let mut point = None;
    for value in values {
        if value.as_entity_ref().is_some() {
            point = Some(point_from_ref(value, decoder)?);
        } else if let Some(typed) = value.as_list() {
            if typed.first().and_then(AttributeValue::as_string) == Some("IFCPARAMETERVALUE") {
                param = typed.get(1).and_then(AttributeValue::as_float);
            }
        } else {
            param = value.as_float().or(param);
        }
    }
    let from_point = point.map(|p| {
        let d = Vector3::from(p) - Vector3::from(center);
        d.dot(&Vector3::from(y)).atan2(d.dot(&Vector3::from(x)))
    });
    let from_param = param.map(|v| v * decoder.plane_angle_to_radians());
    Ok(if cartesian {
        from_point.or(from_param)
    } else {
        from_param.or(from_point)
    })
}

pub(super) fn arc_through(start: [f64; 3], middle: [f64; 3], end: [f64; 3]) -> Option<Segment> {
    let a = Point3::from(start);
    let b = Point3::from(middle);
    let c = Point3::from(end);
    let u = b - a;
    let v = c - a;
    let normal = u.cross(&v).try_normalize(1e-12)?;
    let cross = u.cross(&v);
    let denominator = 2.0 * cross.norm_squared();
    if denominator <= 1e-24 {
        return None;
    }
    let center =
        a + (v.norm_squared() * cross.cross(&u) + u.norm_squared() * v.cross(&cross)) / denominator;
    let x = (a - center).try_normalize(1e-12)?;
    let y = normal.cross(&x);
    let mid_angle = (b - center)
        .dot(&y)
        .atan2((b - center).dot(&x))
        .rem_euclid(TAU);
    let end_angle = (c - center)
        .dot(&y)
        .atan2((c - center).dot(&x))
        .rem_euclid(TAU);
    let sweep = if mid_angle <= end_angle {
        end_angle
    } else {
        end_angle - TAU
    };
    Some(Segment::Arc {
        center: center.into(),
        normal: normal.into(),
        x_axis: x.into(),
        radius: (a - center).norm(),
        start_angle: 0.0,
        sweep_angle: sweep,
    })
}

pub(super) fn trim_indexed_segments(
    segments: &[Segment],
    start: Option<f64>,
    end: Option<f64>,
) -> Result<Vec<Segment>> {
    let n = segments.len() as f64;
    let start = start.unwrap_or(0.0);
    let end = end.unwrap_or(n);
    if start < 0.0 || end > n || end <= start {
        return Err(invalid("invalid swept disk directrix parameter range"));
    }
    let mut out = Vec::new();
    for (i, segment) in segments.iter().enumerate() {
        let left = start.max(i as f64);
        let right = end.min((i + 1) as f64);
        if right > left {
            out.push(segment.subsegment(left - i as f64, right - i as f64));
        }
    }
    Ok(out)
}

/// Parameter spans for the primitives emitted by a bounded parent curve.
/// Unknown parametrizations are reported as unsupported rather than guessed.
pub(super) fn parent_piece_spans(
    parent: &DecodedEntity,
    pieces: &[Segment],
    decoder: &mut EntityDecoder,
) -> Result<Option<Vec<f64>>> {
    match parent.ifc_type {
        IfcType::IfcPolyline => Ok(Some(vec![1.0; pieces.len()])),
        IfcType::IfcTrimmedCurve if pieces.len() == 1 => {
            let basis = resolve(parent.get(0), decoder)?;
            match (&pieces[0], &basis.ifc_type) {
                (Segment::Line { start, end }, IfcType::IfcLine) => {
                    let (_, vector) = line_basis(&basis, decoder)?;
                    let magnitude = Vector3::from(vector).norm();
                    if magnitude <= 1e-12 {
                        return Ok(None);
                    }
                    let length = (Vector3::from(*end) - Vector3::from(*start)).norm();
                    Ok(Some(vec![length / magnitude]))
                }
                (Segment::Arc { sweep_angle, .. }, IfcType::IfcCircle) => {
                    let scale = decoder.plane_angle_to_radians();
                    if !scale.is_finite() || scale <= 0.0 {
                        return Ok(None);
                    }
                    Ok(Some(vec![sweep_angle.abs() / scale]))
                }
                _ => Ok(None),
            }
        }
        _ => Ok(None),
    }
}
