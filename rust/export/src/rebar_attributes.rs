// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{attribute_names_for_schema, AttributeValue, DecodedEntity};

use super::rebar_schedule::AuthoredRebarValue;

pub(super) const FIELDS: &[&str] = &[
    "Tag",
    "SteelGrade",
    "NominalDiameter",
    "CrossSectionArea",
    "BarLength",
    "BarRole",
    "PredefinedType",
    "BarSurface",
    "BendingShapeCode",
];

pub(super) fn attribute(
    entity: &DecodedEntity,
    schema: &str,
    name: &str,
    scale: f64,
    area_scale: Option<f64>,
) -> Result<Option<AuthoredRebarValue>, &'static str> {
    let names = attribute_names_for_schema(schema, entity.ifc_type.name())
        .ok_or("unknown schema entity")?;
    let Some(index) = names.iter().position(|candidate| *candidate == name) else {
        return Ok(None);
    };
    let Some(value) = entity.get(index) else {
        return Ok(None);
    };
    if matches!(value, AttributeValue::Null | AttributeValue::Derived) {
        return Ok(None);
    }
    let unit = match name {
        "NominalDiameter" | "BarLength" => Some((scale, "m")),
        "CrossSectionArea" => Some((area_scale.ok_or("unresolved project area unit")?, "m2")),
        _ => None,
    };
    if let Some((factor, si_unit)) = unit {
        let raw = value.as_float().ok_or("expected numeric measure")?;
        let si = raw * factor;
        if !raw.is_finite() || !si.is_finite() {
            return Err("non-finite measure or unit conversion");
        }
        if (name == "NominalDiameter" || name == "BarLength") && raw <= 0.0 {
            return Err("expected a positive measure");
        }
        if name == "CrossSectionArea" && raw < 0.0 {
            return Err("expected a nonnegative measure");
        }
        return Ok(Some(AuthoredRebarValue::Measure {
            value_file_units: raw,
            value_si: si,
            si_unit,
        }));
    }
    let text = value
        .as_string()
        .or_else(|| value.as_enum())
        .ok_or("expected text or enum")?;
    Ok(Some(AuthoredRebarValue::Text {
        value: text.to_string(),
    }))
}
