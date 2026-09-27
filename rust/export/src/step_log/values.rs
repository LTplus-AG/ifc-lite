// SPDX-License-Identifier: MPL-2.0
//! Attribute-value serializers for authored values (`step-serialization.ts`,
//! `select-qualification.ts`, `attribute-real-slots.ts`,
//! `step-attribute-serializers.ts`): what a positional edit or a created
//! entity's `IfcAttributeValue` is written as.
//!
//! Values arrive as JSON: `IfcAttributeValue` is `string | number | boolean |
//! null | { real } | { typed: { type, value } } | IfcAttributeValue[]`.
//! `importMutations` revives a non-finite marker only where it is a whole
//! `newValue`, so a marker INSIDE a list stays an object; `top` carries that
//! distinction.

use serde_json::Value;

use crate::generated::step_log_tables::{DEFINED_TYPE_BASES, SELECT_LEAVES, SELECT_SLOTS};
use crate::step_text::escape;

use super::attrs::is_real_slot;
use super::jsval::{js_number_to_string, js_to_number, json_number, json_to_js_string, to_step_real};

/// A value no STEP spelling exists for: a non-finite list member.
#[derive(Debug)]
pub(crate) struct Unwritable(pub(crate) String);

/// `resolveExpressBase` for a defined type.
fn express_base(type_name: &str) -> Option<&'static str> {
    DEFINED_TYPE_BASES.binary_search_by(|r| r.0.cmp(type_name)).ok().map(|i| DEFINED_TYPE_BASES[i].1)
}

/// `coerceLogical`.
fn coerce_logical(value: &Value) -> Option<bool> {
    if let Some(b) = value.as_bool() {
        return Some(b);
    }
    if let Some(n) = json_number(value) {
        return Some(n != 0.0);
    }
    match json_to_js_string(value).trim().to_uppercase().as_str() {
        "TRUE" | ".T." | "T" | "1" => Some(true),
        "FALSE" | ".F." | "F" | "0" => Some(false),
        _ => None,
    }
}

/// `serializeTypedMarker`: `IFC<TYPE>(<inner>)`, the inner value written for
/// the type's EXPRESS base.
pub(crate) fn typed_marker(type_name: &str, value: &Value) -> String {
    let inner = match express_base(type_name) {
        Some("REAL") | Some("NUMBER") => to_step_real(js_to_number(value)),
        Some("INTEGER") => js_number_to_string(js_to_number(value).trunc()),
        Some("BOOLEAN") => if coerce_logical(value) == Some(true) { ".T." } else { ".F." }.to_string(),
        Some("LOGICAL") => match coerce_logical(value) {
            Some(true) => ".T.".to_string(),
            Some(false) => ".F.".to_string(),
            None => ".U.".to_string(),
        },
        Some("STRING") | Some("BINARY") => format!("'{}'", escape(&json_to_js_string(value))),
        _ => match value {
            Value::Bool(b) => if *b { ".T." } else { ".F." }.to_string(),
            _ => match json_number(value) {
                Some(n) if n.is_finite() && n.fract() == 0.0 => js_number_to_string(n),
                Some(n) => to_step_real(n),
                None => format!("'{}'", escape(&json_to_js_string(value))),
            },
        },
    };
    let mut token = type_name.to_uppercase();
    if !token.starts_with("IFC") {
        token = format!("IFC{token}");
    }
    format!("{token}({inner})")
}

fn is_marker(value: &Value) -> bool {
    matches!(value, Value::Object(m) if m.contains_key("real") || m.contains_key("typed"))
}

/// A number as `typeof === 'number'` sees it: a JSON number, or (only as a
/// whole value) the non-finite marker.
fn as_number(value: &Value, top: bool) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Object(_) if top => json_number(value),
        _ => None,
    }
}

/// `serializeStepValue(value, forceReal)`.
pub(crate) fn step_value(value: &Value, force_real: bool) -> Result<String, Unwritable> {
    step_value_at(value, force_real, false, true)
}

fn step_value_at(value: &Value, force_real: bool, in_list: bool, top: bool) -> Result<String, Unwritable> {
    if value.is_null() {
        return Ok("$".to_string());
    }
    if let Some(b) = value.as_bool() {
        return Ok(if b { ".T." } else { ".F." }.to_string());
    }
    if let Some(n) = as_number(value, top) {
        if !n.is_finite() {
            if in_list {
                return Err(Unwritable(format!(
                    "Cannot write {} as a STEP list member: '$' omits a whole attribute and is not a legal list element",
                    js_number_to_string(n)
                )));
            }
            return Ok("$".to_string());
        }
        if force_real {
            return Ok(to_step_real(n));
        }
        return Ok(if n.fract() == 0.0 { js_number_to_string(n) } else { to_step_real(n) });
    }
    if let Value::Array(items) = value {
        let parts: Result<Vec<String>, Unwritable> =
            items.iter().map(|v| step_value_at(v, force_real, true, false)).collect();
        return Ok(format!("({})", parts?.join(",")));
    }
    if let Value::Object(m) = value {
        if let Some(real) = m.get("real") {
            return Ok(to_step_real(js_to_number(real)));
        }
        if let Some(typed) = m.get("typed") {
            let ty = typed.get("type").map(json_to_js_string).unwrap_or_default();
            let inner = typed.get("value").cloned().unwrap_or(Value::Null);
            return Ok(typed_marker(&ty, &inner));
        }
        return Ok("'[object Object]'".to_string());
    }
    let text = json_to_js_string(value);
    let trimmed = text.trim();
    if trimmed == "$" || trimmed == "*" {
        return Ok(trimmed.to_string());
    }
    if trimmed.len() >= 2 && trimmed.starts_with('#') && trimmed[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Ok(trimmed.to_string());
    }
    if trimmed.len() >= 3
        && trimmed.starts_with('.')
        && trimmed.ends_with('.')
        && trimmed[1..trimmed.len() - 1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Ok(trimmed.to_uppercase());
    }
    Ok(format!("'{}'", escape(&text)))
}

/// `serializeQualifiedSelectSlot`: a scalar in a SELECT slot written as the
/// one defined-type member of its value's family, when there is exactly one.
fn qualified_select(upper: &str, index: usize, value: &Value) -> Option<String> {
    let select = SELECT_SLOTS
        .iter()
        .find(|r| r.0 == upper && usize::from(r.1) == index)
        .map(|r| r.2)?;
    let families: &[&str] = match value {
        Value::Bool(_) => &["BOOLEAN", "LOGICAL"],
        Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => &["REAL", "NUMBER", "INTEGER"],
        Value::String(s) => {
            let t = s.trim();
            let is_ref = t.len() >= 2 && t.starts_with('#') && t[1..].bytes().all(|b| b.is_ascii_digit());
            let is_enum = t.len() >= 3
                && t.starts_with('.')
                && t.ends_with('.')
                && t[1..t.len() - 1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
            if t == "$" || t == "*" || is_ref || is_enum {
                return None;
            }
            &["STRING", "BINARY"]
        }
        _ => return None,
    };
    let leaves: Vec<(&str, &str)> = SELECT_LEAVES.iter().filter(|r| r.0 == select).map(|r| (r.1, r.2)).collect();
    for family in families {
        let matches: Vec<&str> = leaves.iter().filter(|(_, b)| b == family).map(|(m, _)| *m).collect();
        match matches.as_slice() {
            [one] => return Some(typed_marker(one, value)),
            [] => continue,
            _ => return None,
        }
    }
    None
}

/// `tokenIsRealLiteral`.
fn token_is_real_literal(token: &str) -> bool {
    let t = token.trim();
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exp) = match digits.find(['e', 'E']) {
        Some(i) => (&digits[..i], Some(&digits[i + 1..])),
        None => (digits, None),
    };
    let (int, frac) = match mantissa.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (mantissa, None),
    };
    let ok_int = !int.is_empty() && int.bytes().all(|b| b.is_ascii_digit());
    let ok_frac = frac.is_none_or(|f| f.bytes().all(|b| b.is_ascii_digit()));
    let ok_exp = exp.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit())
    });
    ok_int && ok_frac && ok_exp && (frac.is_some() || exp.is_some())
}

/// `serializePositionalOverride`.
pub(crate) fn positional_override(upper: &str, index: usize, value: &Value, current: &str, schema: &str) -> Result<String, Unwritable> {
    if is_marker(value) {
        return step_value(value, false);
    }
    if let Some(q) = qualified_select(upper, index, value) {
        return Ok(q);
    }
    let force_real = is_real_slot(upper, index, schema) || token_is_real_literal(current);
    step_value(value, force_real)
}

/// `serializeAttributeSlot`: one authored attribute of a created entity.
pub(crate) fn attribute_slot(upper: &str, index: usize, value: &Value, schema: &str) -> Result<String, Unwritable> {
    if is_marker(value) {
        return step_value(value, false);
    }
    if let Some(q) = qualified_select(upper, index, value) {
        return Ok(q);
    }
    step_value(value, is_real_slot(upper, index, schema))
        .map_err(|e| Unwritable(format!("{upper} attribute {index}: {}", e.0)))
}
