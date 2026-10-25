// SPDX-License-Identifier: MPL-2.0
//! A regenerated property's `NominalValue` token: `serializeNominalValue`
//! (`declared-property-type.ts`) and its fallback `serializePropertyValue`
//! (`property-value-serialization.ts`).
//!
//! The four gates `declaredNominalValueType` applies are ported in order. The
//! `IfcValue` members, each one's type in each schema (walked through that
//! schema's registry, where the TypeScript reads IFC4's for all) and each
//! constrained leaf's relaxation target come from `generated::step_log_tables`. The eight WHERE rules are the
//! closed set `CONSTRAINED_MEMBERS` lists; the generator carries which leaves
//! they are, and the predicates are restated here.

use std::borrow::Cow;

use ifc_lite_core::SchemaFamily;
use serde_json::Value;

use super::base::pvt;
use super::jsval::{format_step_real, js_to_number, json_number, json_to_js_string, step_integer};
use crate::generated::step_log_tables::{BaseKind, ValueMember, ValueType, IFC_VALUE_MEMBERS};
use crate::step_text::escape;

impl BaseKind {
    /// The EXPRESS spelling.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::String => "STRING",
            Self::Real => "REAL",
            Self::Number => "NUMBER",
            Self::Integer => "INTEGER",
            Self::Boolean => "BOOLEAN",
            Self::Logical => "LOGICAL",
            Self::Binary => "BINARY",
        }
    }
}

/// The `IfcValue` member `measure` (any case) names in `family` (IFC5 reads
/// IFC4X3's), with its type. `None` when that schema's `IfcValue` has no
/// such member. The one lookup of an `IfcValue` member's type: every check
/// and writer of a typed value asks it.
///
/// The type is IFC4's wherever IFC4 has the member, as every writer has
/// always spelled it. Known gap: IFC4X3 declares `IfcCountMeasure` over
/// INTEGER (IFC4: NUMBER), and a count is still written as a real there,
/// until the follow-up on `fix/ifc4x3-count-measure`.
pub(crate) fn value_member(family: SchemaFamily, measure: &str) -> Option<(&'static ValueMember, ValueType)> {
    let column = match family {
        SchemaFamily::Ifc2x3 => 0,
        SchemaFamily::Ifc4 => 1,
        _ => 2,
    };
    let token = measure.to_ascii_uppercase();
    let member = &IFC_VALUE_MEMBERS[IFC_VALUE_MEMBERS.binary_search_by(|m| m.token.cmp(&token)).ok()?];
    member.in_schemas[column].then_some((member, member.ty))
}

/// The base of `type_name` (any case) as an `IfcValue` leaf of `family`.
fn leaf_base(family: SchemaFamily, type_name: &str) -> Option<BaseKind> {
    match value_member(family, type_name)? {
        (_, ValueType::Leaf(base)) => Some(base),
        (_, ValueType::Aggregate) => None,
    }
}

/// The `IfcValue` leaf `measure` names in `family`, or the reason it is not
/// one: the file's schema is unknown (`None`), the name is a typo, another
/// schema's type, an entity or enumeration (`IFCWALL`), or an aggregate
/// member (`IFCCOMPLEXNUMBER`), which has no single value to write.
fn value_leaf(family: Option<SchemaFamily>, measure: &str) -> Result<(&'static ValueMember, BaseKind), String> {
    let Some(family) = family else {
        return Err(format!("{measure} cannot be checked: the file's schema is not one this engine knows"));
    };
    match value_member(family, measure) {
        Some((member, ValueType::Leaf(base))) => Ok((member, base)),
        Some((member, ValueType::Aggregate)) => {
            Err(format!("{} is an aggregate value type, which a single-value write cannot carry", member.name))
        }
        None => Err(format!("{measure} is not an IFC measure in {}", family.as_str())),
    }
}

/// How a number is written as a value of a numeric measure.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MeasureNumber {
    /// As a STEP REAL: the measure's base is REAL or NUMBER.
    Real,
    /// As a STEP INTEGER: the base is INTEGER, and the value is whole.
    Integer(i64),
}

/// How `value` is written as a value of `measure` in `family`, refused
/// unless the measure is numeric there and, when `where_rule`, `value`
/// keeps its WHERE rule. A measure over INTEGER takes only a whole number
/// (`IfcPositiveInteger`, `IfcInteger`).
pub(crate) fn check_real_measure(family: Option<SchemaFamily>, measure: &str, value: f64, where_rule: bool) -> Result<MeasureNumber, String> {
    let (member, base) = value_leaf(family, measure)?;
    let number = match base {
        BaseKind::Real | BaseKind::Number => MeasureNumber::Real,
        // Whole and exactly representable: below 2^53.
        BaseKind::Integer if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 => MeasureNumber::Integer(value as i64),
        BaseKind::Integer => {
            let family = family.map_or("", SchemaFamily::as_str);
            return Err(format!("{} takes a whole number in {family}, not {value}", member.name));
        }
        other => return Err(format!("{} holds a {} value, not a number", member.name, other.as_str())),
    };
    if where_rule && !satisfies(member.name, value) {
        return Err(format!("{value} is outside what {} allows", member.name));
    }
    Ok(number)
}

/// `literal` as STEP writes a value of `measure` in `family`: a bare integer
/// given for a measure whose base there is REAL or NUMBER gets its decimal
/// point (`3` -> `3.`), since STEP REAL requires one. Anything else is
/// returned as given.
pub(crate) fn canonical_literal<'l>(family: Option<SchemaFamily>, measure: &str, literal: &'l str) -> Cow<'l, str> {
    let is_real = family.and_then(|f| leaf_base(f, measure)).is_some_and(|base| matches!(base, BaseKind::Real | BaseKind::Number));
    let digits = literal.strip_prefix(['+', '-']).unwrap_or(literal);
    if is_real && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        Cow::Owned(format!("{literal}."))
    } else {
        Cow::Borrowed(literal)
    }
}

/// Refuse `literal` (one STEP value, as it would follow the measure's name,
/// e.g. `5.` or `'x'`) unless it is a value of the `measure` type in
/// `family`: a string for a text measure, a number for a numeric one, a
/// STEP enumeration literal for a boolean or logical, a STEP binary for a
/// binary, each within the measure's WHERE rule when `where_rule` (a
/// property; a quantity has its own rule, not negative). The one check a
/// caller-serialized value passes.
pub(crate) fn check_literal_measure(family: Option<SchemaFamily>, measure: &str, literal: &str, where_rule: bool) -> Result<(), String> {
    let (member, base) = value_leaf(family, measure)?;
    let name = member.name;
    let bad = || format!("{literal} is not a valid {name} value");
    let number = |integer_only: bool| -> Result<f64, String> {
        let body = literal.strip_prefix(['+', '-']).unwrap_or(literal);
        let digits = body.bytes().take_while(u8::is_ascii_digit).count();
        let rest = &body[digits..];
        let shaped = digits > 0
            && if integer_only {
                rest.is_empty()
            } else {
                // STEP REAL needs the point before an exponent (`1.E5`, not `1E5`).
                let frac = if rest.starts_with(['e', 'E']) { "!" } else { rest.strip_prefix('.').unwrap_or(rest) };
                let frac = frac.trim_start_matches(|c: char| c.is_ascii_digit());
                let exp = frac.strip_prefix(['e', 'E']).map(|e| e.strip_prefix(['+', '-']).unwrap_or(e));
                frac.is_empty() || exp.is_some_and(|e| !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit()))
            };
        literal.parse::<f64>().ok().filter(|v| shaped && v.is_finite()).ok_or_else(bad)
    };
    match base {
        BaseKind::String => {
            let inner = literal.strip_prefix("'").and_then(|l| l.strip_suffix("'"));
            let balanced = inner.is_some_and(|i| !i.replace("''", "").contains("'"));
            balanced.then_some(()).ok_or_else(bad)
        }
        BaseKind::Real | BaseKind::Number | BaseKind::Integer => {
            let v = number(base == BaseKind::Integer)?;
            (!where_rule || satisfies(name, v)).then_some(()).ok_or_else(|| format!("{literal} is outside what {name} allows"))
        }
        BaseKind::Boolean => matches!(literal, ".T." | ".F.").then_some(()).ok_or_else(bad),
        BaseKind::Logical => matches!(literal, ".T." | ".F." | ".U.").then_some(()).ok_or_else(bad),
        BaseKind::Binary => is_step_binary(literal).then_some(()).ok_or_else(bad),
    }
}

/// A STEP binary (ISO 10303-21): quoted, a first digit 0-3 counting the
/// unused high bits of the first hex digit, then upper-case hex digits. With
/// no hex digits there are no bits to leave unused, so the count is 0.
fn is_step_binary(literal: &str) -> bool {
    let Some(body) = literal.strip_prefix('"').and_then(|l| l.strip_suffix('"')) else { return false };
    let Some((unused, hex)) = body.split_at_checked(1) else { return false };
    let unused_ok = if hex.is_empty() { unused == "0" } else { matches!(unused, "0" | "1" | "2" | "3") };
    unused_ok && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F'))
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

fn accepted_bases(ty: u8) -> Option<&'static [BaseKind]> {
    match ty {
        pvt::STRING | pvt::LABEL | pvt::TEXT | pvt::IDENTIFIER => Some(&[BaseKind::String]),
        pvt::REAL => Some(&[BaseKind::Real, BaseKind::Number]),
        pvt::INTEGER => Some(&[BaseKind::Integer, BaseKind::Number]),
        pvt::BOOLEAN => Some(&[BaseKind::Boolean]),
        pvt::LOGICAL => Some(&[BaseKind::Logical]),
        _ => None,
    }
}

fn fits_base(value: &Value, base: BaseKind) -> bool {
    match base {
        BaseKind::String => value.is_string(),
        BaseKind::Real | BaseKind::Number => json_number(value).is_some_and(f64::is_finite),
        BaseKind::Integer => json_number(value).is_some_and(|n| n.fract() == 0.0 && step_integer(n).is_some()),
        BaseKind::Boolean | BaseKind::Logical => value.is_boolean(),
        BaseKind::Binary => false,
    }
}

fn is_absent(value: &Value) -> bool {
    value.is_null()
}

/// `declaredNominalValueType`. The declared type is read as the TypeScript
/// twin reads it, an IFC4 `IfcValue` member with its IFC4 base whatever the
/// file's schema, so regeneration stays byte-identical to it (#5941).
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
    let (member, ValueType::Leaf(base)) = value_member(SchemaFamily::Ifc4, data_type?.trim())? else { return None };
    if !accepted_bases(ty)?.contains(&base) {
        return None;
    }
    if !fits_base(value, base) {
        return None;
    }
    if member.constrained && !satisfies(member.name, json_number(value).unwrap_or(f64::NAN)) {
        return (!member.relaxed.is_empty()).then_some(member.relaxed);
    }
    Some(member.name)
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
