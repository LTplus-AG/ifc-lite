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
use super::jsval::{format_step_real, js_to_number, json_number, json_to_js_string, step_integer};
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

/// Refuse `value` as the `measure` (any case) measure unless `schema` (a
/// `FILE_SCHEMA` label) declares it over a REAL or NUMBER and, when
/// `where_rule`, `value` keeps the measure's WHERE rule.
pub(crate) fn check_real_measure(schema: &str, measure: &str, value: f64, where_rule: bool) -> Result<(), String> {
    let token = measure.to_ascii_uppercase();
    let leaf = leaf(&token).filter(|_| super::retype::schema_declares(schema, &token));
    let (name, base, _, _) = leaf.ok_or_else(|| format!("{measure} is not an IFC measure in {schema}"))?;
    if !matches!(base, "REAL" | "NUMBER") {
        return Err(format!("{name} is a {base}, not a number"));
    }
    if where_rule && !satisfies(name, value) {
        return Err(format!("{value} is outside what {name} allows"));
    }
    Ok(())
}

/// `literal` as STEP writes a value of `measure`: a bare integer given for a
/// REAL or NUMBER measure gets its decimal point (`3` -> `3.`), since STEP
/// REAL requires one. Anything else is returned as given.
pub(crate) fn canonical_literal(measure: &str, literal: &str) -> String {
    let is_real = leaf(&measure.to_ascii_uppercase()).is_some_and(|(_, base, _, _)| matches!(base, "REAL" | "NUMBER"));
    let digits = literal.strip_prefix(['+', '-']).unwrap_or(literal);
    if is_real && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        format!("{literal}.")
    } else {
        literal.to_string()
    }
}

/// Refuse `literal` (one STEP value, as it would follow the measure's name,
/// e.g. `5.` or `'x'`) unless it is a value of the `measure` type in
/// `schema`: a string for a text measure, a number for a numeric one, a
/// STEP enumeration literal for a boolean or logical, each within the
/// measure's WHERE rule. The one check a caller-serialized value passes.
pub(crate) fn check_literal_measure(schema: &str, measure: &str, literal: &str) -> Result<(), String> {
    let token = measure.to_ascii_uppercase();
    let leaf = leaf(&token).filter(|_| super::retype::schema_declares(schema, &token));
    let (name, base, _, _) = leaf.ok_or_else(|| format!("{measure} is not an IFC measure in {schema}"))?;
    let bad = || format!("{literal} is not a valid {name} value");
    let number = |integer_only: bool| -> Result<f64, String> {
        let body = literal.strip_prefix(['+', '-']).unwrap_or(literal);
        let digits = body.bytes().take_while(u8::is_ascii_digit).count();
        let rest = &body[digits..];
        let shaped = digits > 0
            && if integer_only {
                rest.is_empty()
            } else {
                let frac = rest.strip_prefix('.').unwrap_or(rest);
                let frac = frac.trim_start_matches(|c: char| c.is_ascii_digit());
                let exp = frac.strip_prefix(['e', 'E']).map(|e| e.strip_prefix(['+', '-']).unwrap_or(e));
                frac.is_empty() || exp.is_some_and(|e| !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit()))
            };
        literal.parse::<f64>().ok().filter(|v| shaped && v.is_finite()).ok_or_else(bad)
    };
    match base {
        "STRING" => {
            let inner = literal.strip_prefix("'").and_then(|l| l.strip_suffix("'"));
            let balanced = inner.is_some_and(|i| !i.replace("''", "").contains("'"));
            balanced.then_some(()).ok_or_else(bad)
        }
        "REAL" | "NUMBER" | "INTEGER" => {
            let v = number(base == "INTEGER")?;
            satisfies(name, v).then_some(()).ok_or_else(|| format!("{literal} is outside what {name} allows"))
        }
        "BOOLEAN" => matches!(literal, ".T." | ".F.").then_some(()).ok_or_else(bad),
        "LOGICAL" => matches!(literal, ".T." | ".F." | ".U.").then_some(()).ok_or_else(bad),
        _ => Err(format!("{name} is a {base}, which a single-value write does not carry")),
    }
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
        "INTEGER" => json_number(value).is_some_and(|n| n.fract() == 0.0 && step_integer(n).is_some()),
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
        pvt::INTEGER => match step_integer(js_round(js_to_number(value))) {
            Some(digits) => format!("IFCINTEGER({digits})"),
            None => "$".to_string(),
        },
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
        // `fits_base` has gated the value, so the marker is writable; the `$`
        // (the whole NominalValue omitted) is the legal fallback if it is not.
        Some(declared) => super::values::typed_marker(declared, value).unwrap_or_else(|_| "$".to_string()),
        None => serialize_property_value(value, ty),
    }
}

#[cfg(test)]
#[path = "nominal_tests.rs"]
mod tests;
