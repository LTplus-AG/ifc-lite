// SPDX-License-Identifier: MPL-2.0
//! Named attribute edits on a source record: `applyAttributeMutations`
//! (`step-attribute-mutations.ts`) and the serializers it calls
//! (`serializeNamedAttribute`, `serializeAttributeValue`,
//! `serializeEnumToken`, `serializeStringSlot`).
//!
//! Where an edit lands and how it is written are schema facts the TypeScript
//! side reads off its registries; here they come from
//! `generated::step_log_tables`, which those same functions produced.

use crate::generated::step_log_tables::{SlotRow, NAME_LISTS, NONE, SLOT_ROWS};
use super::lines::split_args;
use crate::step_text::escape;

use super::jsval::{js_number_to_string, to_step_real};

/// The source schema family (`dataStore.schemaVersion`): `IFC2X3`, `IFC4`,
/// `IFC4X3` or `IFC5`, from the first `FILE_SCHEMA` identifier that names
/// one, else a loose scan of the header, else `IFC4`.
pub(crate) fn schema_family(content: &[u8]) -> &'static str {
    let from = |token: &str| -> Option<&'static str> {
        let t = token.trim().to_ascii_uppercase();
        if t.starts_with("IFC5") {
            Some("IFC5")
        } else if t.starts_with("IFC4X3") {
            Some("IFC4X3")
        } else if t.starts_with("IFC4") {
            Some("IFC4")
        } else if t.starts_with("IFC2X3") {
            Some("IFC2X3")
        } else {
            None
        }
    };
    for label in crate::source_header::declared_schemas(content) {
        if let Some(f) = from(&label) {
            return f;
        }
    }
    let head = String::from_utf8_lossy(&content[..content.len().min(2000)]).to_ascii_uppercase();
    for f in ["IFC5", "IFC4X3", "IFC4", "IFC2X3"] {
        if head.contains(f) {
            return f;
        }
    }
    "IFC4"
}

fn row(upper: &str) -> Option<&'static SlotRow> {
    SLOT_ROWS.binary_search_by(|r| r.0.cmp(upper)).ok().map(|i| &SLOT_ROWS[i])
}

/// `attrIndex(type, name, stepSourceSchema(schema))`.
pub(crate) fn attr_index(upper: &str, name: &str, schema: &str) -> Option<usize> {
    let row = row(upper)?;
    let column = match schema {
        "IFC2X3" => 0,
        "IFC4" => 1,
        "IFC4X3" => 2,
        _ => 3,
    };
    let list = match row.1[column] {
        NONE => row.1[3],
        i => i,
    };
    if list == NONE {
        return None;
    }
    NAME_LISTS[usize::from(list)].iter().position(|n| *n == name)
}

/// The declared attribute names `attrIndex` resolves against, for readers
/// that need a name by position.
pub(crate) fn attr_names(upper: &str, schema: &str) -> &'static [&'static str] {
    let Some(row) = row(upper) else { return &[] };
    let column = match schema {
        "IFC2X3" => 0,
        "IFC4" => 1,
        "IFC4X3" => 2,
        _ => 3,
    };
    let list = match row.1[column] {
        NONE => row.1[3],
        i => i,
    };
    if list == NONE {
        &[]
    } else {
        NAME_LISTS[usize::from(list)]
    }
}

/// `getAttributeNamesForSchema(type, schema)`: the schema registry's list
/// when it declares the type, else the cross-schema one.
pub(crate) fn schema_names(upper: &str, schema: &str) -> &'static [&'static str] {
    let Some(row) = row(upper) else { return &[] };
    let column = match schema {
        "IFC2X3" => 4,
        "IFC4" => 5,
        "IFC4X3" => 6,
        _ => 3,
    };
    let list = match row.1[column] {
        NONE => row.1[3],
        i => i,
    };
    if list == NONE {
        &[]
    } else {
        NAME_LISTS[usize::from(list)]
    }
}

fn has(mask: u64, index: usize) -> bool {
    index < 64 && mask & (1 << index) != 0
}

pub(crate) fn is_enum_slot(upper: &str, index: usize) -> bool {
    row(upper).is_some_and(|r| has(r.2, index))
}

pub(crate) fn is_string_slot(upper: &str, index: usize) -> bool {
    row(upper).is_some_and(|r| has(r.3, index))
}

/// `getRealTypedSlots(type, version).has(index)`; anything but IFC2X3 and
/// IFC4X3 reads the IFC4 column, as `toDataSchemaVersion` does.
pub(crate) fn is_real_slot(upper: &str, index: usize, schema: &str) -> bool {
    let column = match schema {
        "IFC2X3" => 0,
        "IFC4X3" => 2,
        _ => 1,
    };
    row(upper).is_some_and(|r| has(r.4[column], index))
}

/// `serializeStringSlot`.
pub(crate) fn string_slot(value: &str) -> String {
    if value == "$" || value == "*" {
        value.to_string()
    } else {
        format!("'{}'", escape(value))
    }
}

/// `serializeEnumToken`. A value that is not an enumeration symbol is written
/// as a quoted string, as the TypeScript side does (it also warns on the
/// console, which has no counterpart in a file).
pub(crate) fn enum_token(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "*" {
        return "*".to_string();
    }
    let symbol = trimmed.strip_prefix('.').unwrap_or(trimmed);
    let symbol = symbol.strip_suffix('.').unwrap_or(symbol).trim().to_uppercase();
    if symbol.is_empty() || symbol == "$" {
        return "$".to_string();
    }
    let valid = symbol.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && symbol.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return string_slot(trimmed);
    }
    format!(".{symbol}.")
}

fn is_enum_like(s: &str) -> bool {
    s.len() >= 3
        && s.starts_with('.')
        && s.ends_with('.')
        && s[1..s.len() - 1].chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_ref(s: &str) -> bool {
    s.len() >= 2 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_digit())
}

/// `/^-?\d+(?:\.\d+)?(?:E[+-]?\d+)?$/i`.
fn is_plain_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac {
            return false;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp {
            return false;
        }
    }
    i == b.len()
}

/// `serializeAttributeValue`: infer the token from the one it replaces.
fn attribute_value(value: &str, current_token: &str) -> String {
    let trimmed = value.trim();
    let current = current_token.trim();
    if current.len() >= 2 && current.starts_with('\'') && current.ends_with('\'') {
        return if value.is_empty() { "$".to_string() } else { format!("'{}'", escape(value)) };
    }
    if value.is_empty() {
        return "$".to_string();
    }
    if trimmed == "$" || trimmed == "*" || is_ref(trimmed) {
        return trimmed.to_string();
    }
    if is_enum_like(current) || is_enum_like(trimmed) {
        let inner = trimmed.strip_prefix('.').unwrap_or(trimmed);
        let inner = inner.strip_suffix('.').unwrap_or(inner);
        return format!(".{}.", inner.to_uppercase());
    }
    if matches!(current.to_ascii_uppercase().as_str(), ".T." | ".F." | ".U.") {
        return match trimmed.to_lowercase().as_str() {
            "true" | ".t." => ".T.".to_string(),
            "false" | ".f." => ".F.".to_string(),
            _ => ".U.".to_string(),
        };
    }
    let current_numeric = current.starts_with(|c: char| c.is_ascii_digit())
        || (current.starts_with('-') && current[1..].starts_with(|c: char| c.is_ascii_digit()));
    if is_plain_number(trimmed) && current_numeric {
        let n: f64 = trimmed.parse().unwrap_or(f64::NAN);
        if !n.is_finite() {
            return "$".to_string();
        }
        return if current.contains('.') || current.contains(['e', 'E']) {
            to_step_real(n)
        } else {
            js_number_to_string(n)
        };
    }
    format!("'{}'", escape(value))
}

/// `serializeNamedAttribute`. `None` is a refusal: a REAL slot handed text
/// that is not a number.
pub(crate) fn named_attribute(upper: &str, index: usize, value: &str, current: &str, schema: &str) -> Option<String> {
    if is_enum_slot(upper, index) {
        return Some(enum_token(value));
    }
    if is_string_slot(upper, index) {
        return Some(string_slot(value));
    }
    if is_real_slot(upper, index, schema) {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Some("$".to_string());
        }
        let n = super::jsval::js_to_number(&serde_json::Value::String(trimmed.to_string()));
        return n.is_finite().then(|| to_step_real(n));
    }
    Some(attribute_value(value, current))
}

/// The argument list of a record, split for by-index writes, with the byte
/// offsets that frame it: `(open, close, args)` where `open` is the first `(`
/// and `close` the last `);`.
pub(crate) fn split_record(text: &str) -> Option<(usize, usize, Vec<String>)> {
    let open = text.find('(')?;
    let close = text.rfind(");")?;
    if close < open {
        return None;
    }
    let args = split_args(&text[open + 1..close])?;
    Some((open, close, args))
}

/// `argumentListScans`: a record with no argument list to find is not
/// "unreadable"; one whose list is there and does not split is.
pub(crate) fn argument_list_scans(text: &str) -> bool {
    match (text.find('('), text.rfind(");")) {
        (Some(open), Some(close)) if close >= open => split_args(&text[open + 1..close]).is_some(),
        _ => true,
    }
}

/// `applyAttributeMutations`: `(text, rejected attribute names)`.
pub(crate) fn apply_named(
    text: &str,
    upper: &str,
    edits: &[(String, String)],
    schema: &str,
) -> (String, Vec<(String, String)>) {
    let Some((open, close, mut args)) = split_record(text) else { return (text.to_string(), Vec::new()) };
    let lookup_schema = match schema {
        "IFC2X3" | "IFC4" | "IFC4X3" => schema,
        _ => "",
    };
    let mut changed = false;
    let mut rejected = Vec::new();
    for (name, value) in edits {
        let Some(index) = attr_index(upper, name, lookup_schema) else { continue };
        if index >= args.len() {
            continue;
        }
        match named_attribute(upper, index, value, &args[index], schema) {
            Some(serialized) => {
                args[index] = serialized;
                changed = true;
            }
            None => rejected.push((name.clone(), value.clone())),
        }
    }
    if !changed {
        return (text.to_string(), rejected);
    }
    (format!("{}{}{}", &text[..=open], args.join(","), &text[close..]), rejected)
}

/// `applyPositionalMutations`: every in-range slot is rewritten, in the order
/// the edits were queued.
pub(crate) fn apply_positional(
    text: &str,
    upper: &str,
    positionals: &[(usize, serde_json::Value)],
    schema: &str,
) -> Result<String, super::values::Unwritable> {
    let Some((open, close, mut args)) = split_record(text) else { return Ok(text.to_string()) };
    let mut changed = false;
    for (index, value) in positionals {
        if *index >= args.len() {
            continue;
        }
        args[*index] = super::values::positional_override(upper, *index, value, &args[*index], schema)?;
        changed = true;
    }
    if !changed {
        return Ok(text.to_string());
    }
    Ok(format!("{}{}{}", &text[..=open], args.join(","), &text[close..]))
}
