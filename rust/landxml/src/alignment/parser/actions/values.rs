// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::super::{
    LandXmlPlanPoint, LandXmlRadius, LandXmlRotation, LandXmlSuperelevationEventKind,
};
use super::super::state::invalid;
use crate::xml::{attr, required, Attributes, Result};

pub(in crate::alignment::parser) fn superelevation_event(
    local: &str,
) -> Option<LandXmlSuperelevationEventKind> {
    Some(match local {
        "BeginRunoutSta" => LandXmlSuperelevationEventKind::BeginRunoutSta,
        "BeginRunoffSta" => LandXmlSuperelevationEventKind::BeginRunoffSta,
        "FullSuperSta" => LandXmlSuperelevationEventKind::FullSuperSta,
        "FullSuperelev" => LandXmlSuperelevationEventKind::FullSuperelev,
        "RunoffSta" => LandXmlSuperelevationEventKind::RunoffSta,
        "StartofRunoutSta" => LandXmlSuperelevationEventKind::StartofRunoutSta,
        "EndofRunoutSta" => LandXmlSuperelevationEventKind::EndofRunoutSta,
        "AdverseSE" => LandXmlSuperelevationEventKind::AdverseSE,
        _ => return None,
    })
}

pub(super) fn finite_attr(attrs: &Attributes, name: &str, context: &str) -> Result<f64> {
    finite(required(attrs, name, context)?, context)
}

pub(super) fn optional_finite_attr(
    attrs: &Attributes,
    name: &str,
    context: &str,
) -> Result<Option<f64>> {
    attr(attrs, name)
        .map(|value| finite(value, context))
        .transpose()
}

fn finite(value: &str, context: &str) -> Result<f64> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| invalid(format!("{context} has invalid numeric value")))?;
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(invalid(format!(
            "{context} requires a finite numeric value"
        )))
    }
}

pub(super) fn radius(value: &str) -> Result<LandXmlRadius> {
    if value == "INF" {
        return Ok(LandXmlRadius::Infinite);
    }
    let value = finite(value, "Spiral radius")?;
    if value > 0.0 {
        Ok(LandXmlRadius::Finite(value))
    } else {
        Err(invalid("Spiral radius must be positive or INF"))
    }
}

pub(super) fn rotation(value: &str) -> Result<LandXmlRotation> {
    match value {
        "cw" => Ok(LandXmlRotation::Clockwise),
        "ccw" => Ok(LandXmlRotation::CounterClockwise),
        _ => Err(invalid("rotation must be cw or ccw")),
    }
}

pub(super) fn plan_point(text: &str) -> Result<LandXmlPlanPoint> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "coordinate"))
        .collect::<Result<_>>()?;
    match values.as_slice() {
        [northing, easting] => Ok(LandXmlPlanPoint {
            northing: *northing,
            easting: *easting,
            elevation: None,
        }),
        [northing, easting, elevation] => Ok(LandXmlPlanPoint {
            northing: *northing,
            easting: *easting,
            elevation: Some(*elevation),
        }),
        _ => Err(invalid("coordinate requires northing easting [elevation]")),
    }
}

pub(super) fn point_list(text: &str, dimension: usize) -> Result<Vec<LandXmlPlanPoint>> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "PntList coordinate"))
        .collect::<Result<_>>()?;
    if values.len() < dimension * 2 || !values.len().is_multiple_of(dimension) {
        return Err(invalid("PntList has an invalid coordinate count"));
    }
    Ok(values
        .chunks_exact(dimension)
        .map(|value| LandXmlPlanPoint {
            northing: value[0],
            easting: value[1],
            elevation: if dimension == 3 { Some(value[2]) } else { None },
        })
        .collect())
}
