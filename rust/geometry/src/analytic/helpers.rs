// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::AnalyticCurveSegment as Segment;
use crate::{Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::TAU;

pub(super) use crate::curve_source::{
    circle_basis, invalid, line_basis, point_from_ref, point_values, resolve,
};

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
