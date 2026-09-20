// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    LandXmlPipeFlow, LandXmlPipeMeasure, LandXmlPipePart, LandXmlPipePosition,
    LandXmlPipeProperties, LandXmlPipeUnits, LandXmlStructurePart,
};

use super::state::{FlowInput, PartInput, PositionInput, RawUnits};

pub(super) fn units(input: &RawUnits) -> Result<LandXmlPipeUnits, String> {
    let linear_unit = required_unit(&input.properties, "linearUnit")?;
    let elevation_unit = input
        .properties
        .get("elevationUnit")
        .cloned()
        // LandXML 1.2 defaults elevations to meters independently from the
        // planar `linearUnit` declaration.
        .unwrap_or_else(|| "meter".to_owned());
    let diameter_unit = input
        .properties
        .get("diameterUnit")
        .cloned()
        .unwrap_or_else(|| linear_unit.clone());
    let width_unit = input
        .properties
        .get("widthUnit")
        .cloned()
        .unwrap_or_else(|| linear_unit.clone());
    let height_unit = input
        .properties
        .get("heightUnit")
        .cloned()
        .unwrap_or_else(|| linear_unit.clone());
    Ok(LandXmlPipeUnits {
        linear_scale_to_meters: scale(&linear_unit)?,
        elevation_scale_to_meters: scale(&elevation_unit)?,
        diameter_scale_to_meters: scale(&diameter_unit)?,
        width_scale_to_meters: scale(&width_unit)?,
        height_scale_to_meters: scale(&height_unit)?,
        linear_unit,
        elevation_unit,
        diameter_unit,
        width_unit,
        height_unit,
        flow_unit: input.properties.get("flowUnit").cloned(),
    })
}

pub(super) fn position(
    input: &PositionInput,
    units: &LandXmlPipeUnits,
) -> Result<LandXmlPipePosition, String> {
    if input.pnt_ref.is_some() {
        return Err("Center pntRef is unsupported without a CgPoints adapter".to_owned());
    }
    let values = finite_values(&input.text, "Center", 2, 3)?;
    Ok(LandXmlPipePosition {
        northing: values[0],
        easting: values[1],
        elevation: values
            .get(2)
            .copied()
            .map(|value| {
                measure(
                    value,
                    &units.elevation_unit,
                    units.elevation_scale_to_meters,
                    false,
                )
            })
            .transpose()?,
    })
}

pub(super) fn pipe_part(
    input: PartInput,
    units: &LandXmlPipeUnits,
) -> Result<LandXmlPipePart, String> {
    match input {
        PartInput::Circ { properties } => Ok(LandXmlPipePart::Circular {
            diameter: required_measure(
                &properties,
                "diameter",
                &units.diameter_unit,
                units.diameter_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.diameter_unit,
                units.diameter_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::Elli { properties } => Ok(LandXmlPipePart::Elliptical {
            span: required_measure(
                &properties,
                "span",
                &units.width_unit,
                units.width_scale_to_meters,
                true,
            )?,
            height: required_measure(
                &properties,
                "height",
                &units.height_unit,
                units.height_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.width_unit,
                units.width_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::Egg { properties } => Ok(LandXmlPipePart::Egg {
            span: required_measure(
                &properties,
                "span",
                &units.width_unit,
                units.width_scale_to_meters,
                true,
            )?,
            height: required_measure(
                &properties,
                "height",
                &units.height_unit,
                units.height_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.width_unit,
                units.width_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::Rect { properties } => Ok(LandXmlPipePart::Rectangular {
            width: required_measure(
                &properties,
                "width",
                &units.width_unit,
                units.width_scale_to_meters,
                true,
            )?,
            height: required_measure(
                &properties,
                "height",
                &units.height_unit,
                units.height_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.width_unit,
                units.width_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::Channel => Err("Channel pipe geometry is unsupported".to_owned()),
        _ => Err("pipe is missing a supported cross-section part".to_owned()),
    }
}

pub(super) fn structure_part(
    input: PartInput,
    units: &LandXmlPipeUnits,
) -> Result<LandXmlStructurePart, String> {
    match input {
        PartInput::StructCirc { properties } => Ok(LandXmlStructurePart::Circular {
            diameter: required_measure(
                &properties,
                "diameter",
                &units.diameter_unit,
                units.diameter_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.diameter_unit,
                units.diameter_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::StructRect { properties } => Ok(LandXmlStructurePart::Rectangular {
            length: required_measure(
                &properties,
                "length",
                &units.linear_unit,
                units.linear_scale_to_meters,
                true,
            )?,
            width: required_measure(
                &properties,
                "width",
                &units.width_unit,
                units.width_scale_to_meters,
                true,
            )?,
            thickness: optional_nonnegative_measure(
                &properties,
                "thickness",
                &units.width_unit,
                units.width_scale_to_meters,
            )?,
            material: properties.get("material").cloned(),
            properties,
        }),
        PartInput::Inlet { properties } => Ok(LandXmlStructurePart::Inlet { properties }),
        PartInput::Outlet { properties } => Ok(LandXmlStructurePart::Outlet { properties }),
        PartInput::Connection { properties } => Ok(LandXmlStructurePart::Connection { properties }),
        _ => Err("structure is missing a supported part".to_owned()),
    }
}

pub(super) fn flow(input: FlowInput, units: &LandXmlPipeUnits) -> Result<LandXmlPipeFlow, String> {
    let flow_in = optional_number(input.flow_in.as_deref(), "flowIn")?;
    let loss_in = optional_number(input.loss_in.as_deref(), "lossIn")?;
    let loss_out = optional_number(input.loss_out.as_deref(), "lossOut")?;
    if flow_in.is_none() && loss_in.is_none() && loss_out.is_none() {
        return Err("flow record is missing flowIn, lossIn, and lossOut".to_owned());
    }
    Ok(LandXmlPipeFlow {
        flow_in,
        loss_in,
        loss_out,
        source_id: input.source_id,
        source_path: input.source_path,
        unit: units.flow_unit.clone(),
        properties: input.properties,
    })
}

pub(super) fn optional_measure(
    properties: &LandXmlPipeProperties,
    key: &str,
    unit: &str,
    scale: f64,
    positive: bool,
) -> Result<Option<LandXmlPipeMeasure>, String> {
    properties
        .get(key)
        .map(|value| parse_measure(value, key, unit, scale, positive))
        .transpose()
}

fn optional_nonnegative_measure(
    properties: &LandXmlPipeProperties,
    key: &str,
    unit: &str,
    scale: f64,
) -> Result<Option<LandXmlPipeMeasure>, String> {
    properties
        .get(key)
        .map(|value| {
            let measure = parse_measure(value, key, unit, scale, false)?;
            if measure.value < 0.0 {
                Err("dimension must not be negative".to_owned())
            } else {
                Ok(measure)
            }
        })
        .transpose()
}

pub(super) fn elevation(
    value: &str,
    units: &LandXmlPipeUnits,
) -> Result<LandXmlPipeMeasure, String> {
    let value = optional_number(Some(value), "elevation")?.expect("value is supplied");
    Ok(LandXmlPipeMeasure {
        value,
        unit: units.elevation_unit.clone(),
        meters: value * units.elevation_scale_to_meters,
    })
}

pub(super) fn required_measure(
    properties: &LandXmlPipeProperties,
    key: &str,
    unit: &str,
    scale: f64,
    positive: bool,
) -> Result<LandXmlPipeMeasure, String> {
    let value = properties
        .get(key)
        .ok_or_else(|| format!("part is missing {key}"))?;
    parse_measure(value, key, unit, scale, positive)
}

fn required_unit(properties: &LandXmlPipeProperties, key: &str) -> Result<String, String> {
    properties
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| format!("Units is missing {key}"))
}

fn parse_measure(
    value: &str,
    label: &str,
    unit: &str,
    scale: f64,
    positive: bool,
) -> Result<LandXmlPipeMeasure, String> {
    let value = optional_number(Some(value), label)?.expect("value is supplied");
    measure(value, unit, scale, positive)
}

fn measure(
    value: f64,
    unit: &str,
    scale: f64,
    positive: bool,
) -> Result<LandXmlPipeMeasure, String> {
    if positive && value <= 0.0 {
        return Err("dimension must be positive".to_owned());
    }
    let meters = value * scale;
    if !meters.is_finite() {
        return Err("scaled measurement must be finite".to_owned());
    }
    Ok(LandXmlPipeMeasure {
        value,
        unit: unit.to_owned(),
        meters,
    })
}

fn optional_number(value: Option<&str>, label: &str) -> Result<Option<f64>, String> {
    value
        .map(|value| {
            let parsed = value
                .parse::<f64>()
                .map_err(|_| format!("{label} is not numeric"))?;
            if parsed.is_finite() {
                Ok(parsed)
            } else {
                Err(format!("{label} must be finite"))
            }
        })
        .transpose()
}

fn finite_values(text: &str, label: &str, min: usize, max: usize) -> Result<Vec<f64>, String> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| value.parse::<f64>().ok())
        .collect::<Option<_>>()
        .ok_or_else(|| format!("{label} contains non-numeric coordinates"))?;
    if values.len() < min || values.len() > max || values.iter().any(|value| !value.is_finite()) {
        return Err(format!(
            "{label} must contain {min} or {max} finite coordinates"
        ));
    }
    Ok(values)
}

fn scale(unit: &str) -> Result<f64, String> {
    match unit {
        "millimeter" => Ok(0.001),
        "centimeter" => Ok(0.01),
        "meter" => Ok(1.0),
        "kilometer" => Ok(1000.0),
        "inch" => Ok(0.0254),
        "foot" | "feet" => Ok(0.3048),
        "USSurveyFoot" => Ok(1200.0 / 3937.0),
        "mile" | "miles" => Ok(1609.344),
        _ => Err(format!("unsupported LandXML unit {unit}")),
    }
}
