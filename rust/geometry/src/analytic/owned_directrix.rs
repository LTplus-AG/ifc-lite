// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Owned numerical input beside its unchanged EXPRESS provenance.
use super::{
    AnalyticBoundarySource, AnalyticCurveSegment, AnalyticStatus, SourceRecord, SourceValue,
};
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use serde::{Deserialize, Serialize};

/// A separate consumer surface; rational curves are not mesh line/arc segments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum OwnedDirectrix {
    Segments(Vec<AnalyticCurveSegment>),
    Rational(OwnedRationalCurve),
}

/// Original Euclidean coefficients in IFC file units. Expanded knots are derived
/// solely by repeating the original unique knots, without fitting or rescaling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnedRationalCurve {
    pub source_entity_id: u32,
    #[serde(rename = "Degree")]
    pub degree: u32,
    #[serde(rename = "ControlPointsList")]
    pub control_points: Vec<[f64; 3]>,
    #[serde(rename = "WeightsData")]
    pub weights: Vec<f64>,
    #[serde(rename = "Knots")]
    pub knots: Vec<f64>,
    #[serde(rename = "KnotMultiplicities")]
    pub multiplicities: Vec<u32>,
    pub expanded_knots: Vec<f64>,
    pub parameter_range: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalyticDirectrix {
    pub source: AnalyticBoundarySource,
    pub geometry: Option<OwnedDirectrix>,
    /// Complete describes extraction, not numerical SDK qualification.
    pub status: AnalyticStatus,
}

/// Reuses the analytic curve walk, including unsupported rational topology.
/// Source capture refusal is independent of interpreted line/arc geometry.
pub fn extract_owned_directrix(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<AnalyticDirectrix> {
    let mut walk = super::curve::CurveWalk::with_source();
    let segments = walk.extract(curve, decoder)?;
    let source = walk
        .source
        .finish(curve.id, decoder.plane_angle_to_radians());
    let lowered = match segments {
        Some(segments) => Ok(OwnedDirectrix::Segments(segments)),
        None => rational_from_source(&source).map(OwnedDirectrix::Rational),
    };
    let (geometry, status) = match lowered {
        Ok(geometry) => (Some(geometry), AnalyticStatus::Complete),
        Err(reason) => (None, AnalyticStatus::Unsupported(reason)),
    };
    Ok(AnalyticDirectrix {
        source,
        geometry,
        status,
    })
}

pub(super) fn rational_from_source(
    source: &AnalyticBoundarySource,
) -> std::result::Result<OwnedRationalCurve, String> {
    if !matches!(source.capture_status, AnalyticStatus::Complete) {
        return Err("rational source capture is incomplete".into());
    }
    rational_from_root(source, source.root_entity_id)
}

pub(super) fn rational_from_root(
    source: &AnalyticBoundarySource,
    root_id: u32,
) -> std::result::Result<OwnedRationalCurve, String> {
    if !matches!(source.capture_status, AnalyticStatus::Complete) {
        return Err("rational source capture is incomplete".into());
    }
    let root = source
        .records
        .get(&root_id)
        .ok_or("unsupported directrix source")?;
    let (basis, trim) = if root.ifc_type_name == "IfcTrimmedCurve" {
        let id = reference(attribute(root, "BasisCurve")?)?;
        (
            source
                .records
                .get(&id)
                .ok_or("missing rational basis source")?,
            Some(root),
        )
    } else {
        (root, None)
    };
    if basis.ifc_type_name != "IfcRationalBSplineCurveWithKnots" {
        return Err("directrix is not a single rational B-spline".into());
    }
    let mut curve = coefficients(basis, source)?;
    if let Some(trim) = trim {
        if attribute(trim, "MasterRepresentation")? != &SourceValue::Enum("PARAMETER".into())
            || attribute(trim, "SenseAgreement")? != &SourceValue::Enum("T".into())
        {
            return Err("rational directrix requires forward parameter-master trims".into());
        }
        let range = [
            parameter(attribute(trim, "Trim1")?)?,
            parameter(attribute(trim, "Trim2")?)?,
        ];
        curve.restrict_range(Some(range[0]), Some(range[1]))?;
    }
    Ok(curve)
}

impl OwnedRationalCurve {
    /// Bounds use the original basis parameter, not normalized fractions or
    /// sample indices. Refuse widening an already trimmed source curve.
    pub(super) fn restrict_range(
        &mut self,
        start: Option<f64>,
        end: Option<f64>,
    ) -> std::result::Result<(), String> {
        let [a, b] = self.parameter_range;
        let start = start.unwrap_or(a);
        let end = end.unwrap_or(b);
        if !start.is_finite() || !end.is_finite() || start < a || end > b || start >= end {
            return Err(
                "rational active parameter range is invalid or outside source bounds".into(),
            );
        }
        self.parameter_range = [start, end];
        Ok(())
    }
}

fn coefficients(
    record: &SourceRecord,
    source: &AnalyticBoundarySource,
) -> std::result::Result<OwnedRationalCurve, String> {
    let degree = integer(attribute(record, "Degree")?)?;
    if !(1..=32).contains(&degree) {
        return Err("unsupported rational degree".into());
    }
    if attribute(record, "ClosedCurve")? != &SourceValue::Enum("F".into())
        || attribute(record, "SelfIntersect")? != &SourceValue::Enum("F".into())
    {
        return Err("rational directrix must declare open, non-self-intersecting topology".into());
    }
    let points = list(attribute(record, "ControlPointsList")?)?;
    if points.len() < degree as usize + 1 || points.len() > 8192 {
        return Err("rational control count exceeds supported bounds".into());
    }
    let control_points = points
        .iter()
        .map(|value| {
            let point = source
                .records
                .get(&reference(value)?)
                .ok_or("missing rational control point")?;
            let coords = list(attribute(point, "Coordinates")?)?;
            if !(2..=3).contains(&coords.len()) {
                return Err("invalid rational control dimension".into());
            }
            let mut out = [0.0; 3];
            for (index, value) in coords.iter().enumerate() {
                out[index] = real(value)?;
            }
            Ok(out)
        })
        .collect::<std::result::Result<Vec<_>, String>>()?;
    let weights = numbers(attribute(record, "WeightsData")?)?;
    let knots = numbers(attribute(record, "Knots")?)?;
    let multiplicities = list(attribute(record, "KnotMultiplicities")?)?
        .iter()
        .map(integer)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if weights.len() != points.len()
        || weights.iter().any(|w| *w <= 0.0)
        || knots.len() < 2
        || knots.len() > 8192
        || knots.len() != multiplicities.len()
        || knots.windows(2).any(|p| p[0] >= p[1])
    {
        return Err("invalid rational weights or knot sequence".into());
    }
    for (index, &multiplicity) in multiplicities.iter().enumerate() {
        let end = index == 0 || index + 1 == knots.len();
        if (end && multiplicity != degree + 1)
            || (!end && (multiplicity == 0 || multiplicity > degree))
        {
            return Err("rational knots must be clamped with valid multiplicities".into());
        }
    }
    let count: u64 = multiplicities.iter().map(|&m| u64::from(m)).sum();
    if count != points.len() as u64 + u64::from(degree) + 1 {
        return Err("rational knot/control count mismatch".into());
    }
    let expanded_knots = knots
        .iter()
        .zip(&multiplicities)
        .flat_map(|(&k, &m)| std::iter::repeat_n(k, m as usize))
        .collect();
    let parameter_range = [knots[0], knots[knots.len() - 1]];
    Ok(OwnedRationalCurve {
        source_entity_id: record.id,
        degree,
        control_points,
        weights,
        knots,
        multiplicities,
        expanded_knots,
        parameter_range,
    })
}

fn attribute<'a>(
    record: &'a SourceRecord,
    name: &str,
) -> std::result::Result<&'a SourceValue, String> {
    record
        .attributes
        .get(name)
        .ok_or_else(|| format!("missing rational source {name}"))
}
fn list(value: &SourceValue) -> std::result::Result<&[SourceValue], String> {
    match value {
        SourceValue::List(values) => Ok(values),
        _ => Err("invalid rational list".into()),
    }
}
fn reference(value: &SourceValue) -> std::result::Result<u32, String> {
    match value {
        SourceValue::EntityRef(id) => Ok(*id),
        _ => Err("invalid rational reference".into()),
    }
}
fn integer(value: &SourceValue) -> std::result::Result<u32, String> {
    match value {
        SourceValue::Integer(i) => u32::try_from(*i).map_err(|_| "invalid rational integer".into()),
        _ => Err("invalid rational integer".into()),
    }
}
fn real(value: &SourceValue) -> std::result::Result<f64, String> {
    match value {
        SourceValue::Real(v) if v.is_finite() => Ok(*v),
        SourceValue::Integer(v) => Ok(*v as f64),
        _ => Err("invalid rational real".into()),
    }
}
fn numbers(value: &SourceValue) -> std::result::Result<Vec<f64>, String> {
    list(value)?.iter().map(real).collect()
}
fn parameter(value: &SourceValue) -> std::result::Result<f64, String> {
    let mut parameters = list(value)?.iter().filter_map(|v| match v {
        SourceValue::Typed { name, value } if name == "IFCPARAMETERVALUE" => Some(real(value)),
        _ => None,
    });
    let result = parameters
        .next()
        .ok_or("missing rational parameter selector")??;
    if parameters.next().is_some() {
        return Err("ambiguous rational parameter selector".into());
    }
    Ok(result)
}
