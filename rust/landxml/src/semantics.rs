/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    xml::{attr, error, required, Attributes, Result},
    LandXmlDiagnosticCode as Code, LandXmlUnits,
};

pub(crate) fn positive_id(value: &str) -> Result<String> {
    let unsigned = value.strip_prefix('+').unwrap_or(value);
    if unsigned.is_empty() || !unsigned.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error(Code::InvalidSemantic, "invalid positive integer id"));
    }
    let canonical = unsigned.trim_start_matches('0');
    if canonical.is_empty() {
        return Err(error(Code::InvalidSemantic, "invalid positive integer id"));
    }
    Ok(canonical.to_owned())
}

pub(crate) fn triple(text: &str, context: &str) -> Result<[f64; 3]> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|part| part.parse::<f64>().ok())
        .collect::<Option<_>>()
        .ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                format!("{context} contains non-numeric coordinate"),
            )
        })?;
    if values.len() != 3 || values.iter().any(|value| !value.is_finite()) {
        return Err(error(
            Code::InvalidSemantic,
            format!("{context} must contain three finite coordinates"),
        ));
    }
    Ok([values[0], values[1], values[2]])
}

pub(crate) fn references(text: &str) -> Result<[String; 3]> {
    let values: Vec<String> = text
        .split_ascii_whitespace()
        .map(positive_id)
        .collect::<Result<_>>()?;
    values.try_into().map_err(|_| {
        error(
            Code::InvalidSemantic,
            "face must reference exactly three points",
        )
    })
}

pub(crate) fn units(attributes: &Attributes) -> Result<LandXmlUnits> {
    let linear = required(attributes, "linearUnit", "Units")?.to_owned();
    let elevation = attr(attributes, "elevationUnit")
        .filter(|unit| !unit.trim().is_empty())
        .unwrap_or(&linear)
        .to_owned();
    Ok(LandXmlUnits {
        linear_scale_to_meters: scale(&linear)?,
        elevation_scale_to_meters: scale(&elevation)?,
        linear_unit: linear,
        elevation_unit: elevation,
    })
}

fn scale(unit: &str) -> Result<f64> {
    match unit {
        "millimeter" => Ok(0.001),
        "centimeter" => Ok(0.01),
        "meter" => Ok(1.0),
        "kilometer" => Ok(1000.0),
        "inch" => Ok(0.0254),
        "foot" | "feet" => Ok(0.3048),
        "USSurveyFoot" => Ok(1200.0 / 3937.0),
        "mile" | "miles" => Ok(1609.344),
        _ => Err(error(Code::InvalidSemantic, "unsupported LandXML unit")),
    }
}
