// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Basis and trim facts shared by analytic descriptions and sampled geometry.

use crate::{Error, Result, Vector3};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(crate) fn invalid(message: &str) -> Error {
    Error::geometry(message.to_string())
}

pub(crate) fn resolve(
    attr: Option<&AttributeValue>,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity> {
    let attr = attr.ok_or_else(|| invalid("missing curve reference"))?;
    decoder
        .resolve_ref(attr)?
        .ok_or_else(|| invalid("curve reference cannot be resolved"))
}

pub(crate) fn point_values(values: &[AttributeValue]) -> Result<[f64; 3]> {
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

pub(crate) fn point_from_ref(
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

fn trim_cartesian_point(
    value: &AttributeValue,
    decoder: &mut EntityDecoder,
    tolerant: bool,
) -> Result<Option<[f64; 3]>> {
    let resolved = resolve(Some(value), decoder);
    let point = match resolved {
        Ok(entity) => entity,
        Err(_) if tolerant => return Ok(None),
        Err(error) => return Err(error),
    };
    if point.ifc_type != IfcType::IfcCartesianPoint {
        return if tolerant {
            Ok(None)
        } else {
            Err(invalid("Trim point is not an IfcCartesianPoint"))
        };
    }
    match point.get_list(0).map(point_values) {
        Some(Ok(coords)) => Ok(Some(coords)),
        Some(Err(_)) | None if tolerant => Ok(None),
        Some(Err(error)) => Err(error),
        None => Err(invalid("CartesianPoint missing Coordinates")),
    }
}

pub(crate) fn vector_from_ref(
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

pub(crate) fn line_basis(
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

/// Preserve the mesh reader's recovery for malformed line coordinates and
/// vectors. Analytic descriptions use [`line_basis`] and reject these values.
pub(crate) fn mesh_line_basis(
    line: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<([f64; 3], [f64; 3])> {
    let pnt = resolve(line.get(0), decoder)?;
    let coords = pnt
        .get(0)
        .and_then(AttributeValue::as_list)
        .ok_or_else(|| invalid("Line Pnt missing coordinates"))?;
    let origin = std::array::from_fn(|i| {
        coords
            .get(i)
            .and_then(AttributeValue::as_float)
            .unwrap_or(0.0)
    });

    let vector = resolve(line.get(1), decoder)?;
    let magnitude = vector
        .get(1)
        .and_then(AttributeValue::as_float)
        .unwrap_or(1.0);
    let orientation = vector
        .get(0)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|d| {
            let coords = d.get(0).and_then(AttributeValue::as_list)?;
            Some(Vector3::new(
                coords.first().and_then(AttributeValue::as_float).unwrap_or(0.0),
                coords.get(1).and_then(AttributeValue::as_float).unwrap_or(0.0),
                coords.get(2).and_then(AttributeValue::as_float).unwrap_or(0.0),
            ))
        })
        .and_then(|v| v.try_normalize(1e-12))
        .unwrap_or_else(Vector3::x);
    Ok((origin, (orientation * magnitude).into()))
}

pub(crate) fn trim_point(
    attr: Option<&AttributeValue>,
    origin: [f64; 3],
    v: [f64; 3],
    cartesian: bool,
    ignore_bad_cartesian: bool,
    decoder: &mut EntityDecoder,
) -> Result<Option<[f64; 3]>> {
    let Some(values) = attr.and_then(AttributeValue::as_list) else {
        return Ok(None);
    };
    let mut param = None;
    let mut point = None;
    for value in values {
        if value.as_entity_ref().is_some() {
            point = trim_cartesian_point(value, decoder, ignore_bad_cartesian)?.or(point);
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

pub(crate) fn circle_basis(
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

pub(crate) fn trim_angle(
    attr: Option<&AttributeValue>,
    center: [f64; 3],
    x: [f64; 3],
    y: [f64; 3],
    cartesian: bool,
    ignore_bad_cartesian: bool,
    decoder: &mut EntityDecoder,
) -> Result<Option<f64>> {
    let Some(values) = attr.and_then(AttributeValue::as_list) else {
        return Ok(None);
    };
    let mut param = None;
    let mut point = None;
    for value in values {
        if value.as_entity_ref().is_some() {
            point = trim_cartesian_point(value, decoder, ignore_bad_cartesian)?.or(point);
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
