/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::super::LandXmlPlanPoint;

pub(super) fn area_scale(unit: &str) -> Result<f64> {
    match unit {
        "squareMillimeter" => Ok(0.000_001),
        "squareCentimeter" => Ok(0.0001),
        "squareMeter" => Ok(1.0),
        "hectare" => Ok(10_000.0),
        "squareFoot" | "squareFeet" => Ok(0.092_903_04),
        "acre" => Ok(4_046.856_422_4),
        _ => Err(error(Code::InvalidSemantic, "unsupported LandXML areaUnit")),
    }
}
use super::*;

pub(super) fn source_id(element: &str, ordinal: usize, attributes: &Attributes) -> LandXmlSourceId {
    let identity = attr(attributes, "oID")
        .or_else(|| attr(attributes, "name"))
        .unwrap_or("unnamed");
    LandXmlSourceId(format!("landxml:{element}:{ordinal}:{identity}"))
}
pub(super) fn optional_finite(
    attributes: &Attributes,
    name: &str,
    context: &str,
) -> Result<Option<f64>> {
    attr(attributes, name)
        .map(|value| finite(value, context))
        .transpose()
}
pub(super) fn optional_positive(
    attributes: &Attributes,
    name: &str,
    context: &str,
) -> Result<Option<f64>> {
    optional_finite(attributes, name, context)?
        .map(|value| {
            if value > 0.0 {
                Ok(value)
            } else {
                Err(error(
                    Code::InvalidSemantic,
                    format!("{context} {name} must be positive"),
                ))
            }
        })
        .transpose()
}
fn finite(value: &str, context: &str) -> Result<f64> {
    let value = value.parse::<f64>().map_err(|_| {
        error(
            Code::InvalidSemantic,
            format!("{context} has invalid numeric value"),
        )
    })?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(error(
            Code::InvalidSemantic,
            format!("{context} requires a finite numeric value"),
        ))
    }
}
pub(super) fn point(text: &str) -> Result<LandXmlPlanPoint> {
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
        _ => Err(error(
            Code::InvalidSemantic,
            "coordinate requires northing easting [elevation]",
        )),
    }
}
pub(super) fn points_limited(
    text: &str,
    dimension: usize,
    remaining: usize,
) -> Result<Vec<LandXmlPlanPoint>> {
    let count = text.split_ascii_whitespace().count();
    if count < dimension * 2 || !count.is_multiple_of(dimension) {
        return Err(error(
            Code::InvalidSemantic,
            "PntList requires at least two complete coordinates",
        ));
    }
    if count / dimension > remaining {
        return Err(error(Code::LimitExceeded, "plan vertex limit exceeded"));
    }
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "PntList coordinate"))
        .collect::<Result<_>>()?;
    Ok(values
        .chunks_exact(dimension)
        .map(|value| LandXmlPlanPoint {
            northing: value[0],
            easting: value[1],
            elevation: if dimension == 3 { Some(value[2]) } else { None },
        })
        .collect())
}
