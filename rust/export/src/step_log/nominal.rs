// SPDX-License-Identifier: MPL-2.0
//! A regenerated property's `NominalValue` token: `serializeNominalValue`
//! (`declared-property-type.ts`) and its fallback `serializePropertyValue`
//! (`property-value-serialization.ts`).
//!
//! The four gates `declaredNominalValueType` applies are ported in order; the
//! `IfcValue` leaves, their EXPRESS bases and each constrained leaf's
//! relaxation target come from `generated::step_log_tables`, which the
//! TypeScript functions themselves produced. The eight WHERE rules are the
//! closed set `CONSTRAINED_MEMBERS` lists; the generator carries which leaves
//! they are, and the predicates are restated here.

use serde_json::Value;

use super::base::pvt;
use super::jsval::{format_step_real, js_number_to_string, js_to_number, json_number, json_to_js_string, to_step_real};
use crate::generated::step_log_tables::NOMINAL_VALUE_LEAVES;
use crate::step_text::escape;

/// `(schema-cased name, EXPRESS base, constrained, relaxed)` for an
/// UPPERCASE `IfcValue` token.
fn leaf(token: &str) -> Option<(&'static str, &'static str, bool, &'static str)> {
    NOMINAL_VALUE_LEAVES
        .binary_search_by(|row| row.0.cmp(token))
        .ok()
        .map(|i| {
            let row = NOMINAL_VALUE_LEAVES[i];
            (row.1, row.2, row.3, row.4)
        })
}

/// The WHERE rule of a constrained member (`CONSTRAINED_MEMBERS`).
fn satisfies(name: &str, v: f64) -> bool {
    match name {
        "IfcPositiveLengthMeasure" | "IfcPositiveRatioMeasure" | "IfcPositivePlaneAngleMeasure"
        | "IfcPositiveInteger" | "IfcHeatingValueMeasure" => v > 0.0,
        "IfcNonNegativeLengthMeasure" => v >= 0.0,
        "IfcNormalisedRatioMeasure" => (0.0..=1.0).contains(&v),
        "IfcPHMeasure" => (0.0..=14.0).contains(&v),
        _ => true,
    }
}

fn accepted_bases(ty: u8) -> Option<&'static [&'static str]> {
    match ty {
        pvt::STRING | pvt::LABEL | pvt::TEXT | pvt::IDENTIFIER => Some(&["STRING"]),
        pvt::REAL => Some(&["REAL", "NUMBER"]),
        pvt::INTEGER => Some(&["INTEGER", "NUMBER"]),
        pvt::BOOLEAN => Some(&["BOOLEAN"]),
        pvt::LOGICAL => Some(&["LOGICAL"]),
        _ => None,
    }
}

fn fits_base(value: &Value, base: &str) -> bool {
    match base {
        "STRING" => value.is_string(),
        "REAL" | "NUMBER" => json_number(value).is_some_and(f64::is_finite),
        "INTEGER" => json_number(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0),
        "BOOLEAN" | "LOGICAL" => value.is_boolean(),
        _ => false,
    }
}

fn is_absent(value: &Value) -> bool {
    value.is_null()
}

/// `declaredNominalValueType`.
fn declared_type(value: &Value, ty: u8, data_type: Option<&str>) -> Option<&'static str> {
    if is_absent(value) {
        return None;
    }
    let named = match ty {
        pvt::LABEL => Some("IfcLabel"),
        pvt::IDENTIFIER => Some("IfcIdentifier"),
        pvt::TEXT => Some("IfcText"),
        _ => None,
    };
    if let Some(named) = named {
        return value.is_string().then_some(named);
    }
    let data_type = data_type?;
    let (name, base, constrained, relaxed) = leaf(&data_type.trim().to_uppercase())?;
    if !accepted_bases(ty)?.contains(&base) {
        return None;
    }
    if !fits_base(value, base) {
        return None;
    }
    if constrained && !satisfies(name, json_number(value).unwrap_or(f64::NAN)) {
        return (!relaxed.is_empty()).then_some(relaxed);
    }
    Some(name)
}

/// `serializeTypedMarker` for a value `fits_base` accepted.
fn typed_marker(declared: &str, value: &Value) -> String {
    let base = leaf(&declared.to_uppercase()).map(|l| l.1);
    let inner = match base {
        Some("REAL") | Some("NUMBER") => to_step_real(js_to_number(value)),
        Some("INTEGER") => js_number_to_string(js_to_number(value).trunc()),
        Some("BOOLEAN") => if value.as_bool() == Some(true) { ".T." } else { ".F." }.to_string(),
        Some("LOGICAL") => match value.as_bool() {
            Some(true) => ".T.".to_string(),
            Some(false) => ".F.".to_string(),
            None => ".U.".to_string(),
        },
        _ => format!("'{}'", escape(&json_to_js_string(value))),
    };
    let mut token = declared.to_uppercase();
    if !token.starts_with("IFC") {
        token = format!("IFC{token}");
    }
    format!("{token}({inner})")
}

/// `Math.round`: halves go toward +Infinity. Not `(v + 0.5).floor()`, which
/// rounds 0.49999999999999994 up because the sum itself rounds.
fn js_round(v: f64) -> f64 {
    let floor = v.floor();
    if v - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `serializePropertyValue`: the token from the property's shape alone.
pub(crate) fn serialize_property_value(value: &Value, ty: u8) -> String {
    if is_absent(value) {
        return if ty == pvt::LOGICAL { "IFCLOGICAL(.U.)".to_string() } else { "$".to_string() };
    }
    let label = |v: &Value| format!("IFCLABEL('{}')", escape(&json_to_js_string(v)));
    match ty {
        pvt::STRING | pvt::LABEL | pvt::ENUM => label(value),
        pvt::TEXT => format!("IFCTEXT('{}')", escape(&json_to_js_string(value))),
        pvt::IDENTIFIER => format!("IFCIDENTIFIER('{}')", escape(&json_to_js_string(value))),
        pvt::REAL => {
            let n = js_to_number(value);
            if n.is_finite() {
                format!("IFCREAL({})", format_step_real(n))
            } else {
                "$".to_string()
            }
        }
        pvt::INTEGER => format!("IFCINTEGER({})", js_number_to_string(js_round(js_to_number(value)))),
        pvt::BOOLEAN => match value.as_bool() {
            Some(true) => "IFCBOOLEAN(.T.)".to_string(),
            Some(false) => "IFCBOOLEAN(.F.)".to_string(),
            None => "IFCLOGICAL(.U.)".to_string(),
        },
        pvt::LOGICAL => match value.as_bool() {
            Some(true) => "IFCLOGICAL(.T.)".to_string(),
            Some(false) => "IFCLOGICAL(.F.)".to_string(),
            None => "IFCLOGICAL(.U.)".to_string(),
        },
        pvt::LIST => match value {
            Value::Array(items) => {
                let parts: Vec<String> = items.iter().map(|v| serialize_property_value(v, pvt::STRING)).collect();
                format!("({})", parts.join(","))
            }
            _ => "$".to_string(),
        },
        _ => label(value),
    }
}

/// `serializeNominalValue`.
pub(crate) fn serialize_nominal_value(value: &Value, ty: u8, data_type: Option<&str>) -> String {
    match declared_type(value, ty, data_type) {
        Some(declared) => typed_marker(declared, value),
        None => serialize_property_value(value, ty),
    }
}

#[cfg(test)]
#[path = "nominal_tests.rs"]
mod tests;
