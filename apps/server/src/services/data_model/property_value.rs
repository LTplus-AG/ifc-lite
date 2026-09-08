// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property VALUE resolution: turning a decoded `IfcProperty` attribute
//! (nominal value, enumerated/list members, complex-property nesting) into
//! the display string + kind + measure tag + candidate list that
//! `properties::extract_property` wires onto a `Property`. Split out of
//! `properties.rs` to keep entity-shape extraction (which pset/property to
//! walk) separate from value-shape resolution (how to stringify one).

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder};

/// Guards `resolve_complex_property_value` against a pathological/cyclic
/// `HasProperties` chain, mirroring the TS `MAX_COMPLEX_PROPERTY_DEPTH` in
/// `packages/parser/src/property-value-parser.ts` exactly: real IFC nests
/// `IfcComplexProperty` at most a couple of levels deep.
pub(super) const MAX_COMPLEX_PROPERTY_DEPTH: u8 = 8;

/// Resolve an `IfcComplexProperty`'s nested `HasProperties` (EXPRESS:
/// `[Name, Description, UsageName, HasProperties]`, index 3) into a display
/// value plus a flat `values` candidate list, recursing into any further
/// nested `IfcComplexProperty` — mirrors `resolveComplexPropertyValue`
/// (`packages/parser/src/property-value-parser.ts`) member-for-member:
///
/// - Not a list, or the depth cap is hit: return the bare `UsageName` (or the
///   "null" kind when it's absent/empty) with NO truncation flag — the TS
///   side is silent about hitting the cap too, it just stops recursing.
/// - Each nested member that resolves to a non-empty display becomes one
///   `"Name: value"` part (or bare `value` when the nested member has no
///   Name); a member that fails to resolve, or resolves to an empty display,
///   is skipped — it does NOT poison the whole complex property.
/// - Nested names are NEVER hoisted to the top level: the complex property
///   still surfaces as ONE `Property` under its own Name (see
///   `extract_property`'s call site), so a name collision between a nested
///   property and a top-level sibling property cannot occur — same as the TS
///   side, where `parsePropertyValueWithComplex` is called once per
///   `HasProperties` member and only ever returns a single value for it.
pub(super) fn resolve_complex_property_value(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    depth: u8,
) -> (String, String, Option<String>, Option<Vec<String>>) {
    let usage_name = entity.get_string(2).map(|s| s.to_string());
    let has_properties_list = if depth < MAX_COMPLEX_PROPERTY_DEPTH {
        entity.get_list(3)
    } else {
        None
    };

    let refs: Vec<u32> = match has_properties_list {
        Some(list) => list.iter().filter_map(|v| v.as_entity_ref()).collect(),
        None => {
            return match usage_name {
                Some(u) if !u.is_empty() => (u, "string".into(), None, None),
                _ => (String::new(), "null".into(), None, None),
            };
        }
    };

    let mut parts: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();

    for prop_id in refs {
        let nested_entity = match decoder.decode_by_id(prop_id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let nested_name = nested_entity
            .get_string(0)
            .map(|s| s.to_string())
            .unwrap_or_default();
        let nested_ty = nested_entity.ifc_type.as_str().to_uppercase();
        let display = if nested_ty == "IFCCOMPLEXPROPERTY" {
            resolve_complex_property_value(&nested_entity, decoder, depth + 1).0
        } else {
            match super::properties::extract_property(&nested_entity, decoder) {
                Some(p) => p.property_value,
                None => continue,
            }
        };
        if display.is_empty() {
            continue;
        }
        if nested_name.is_empty() {
            parts.push(display.clone());
        } else {
            parts.push(format!("{}: {}", nested_name, display));
        }
        values.push(display);
    }

    let value = if !parts.is_empty() {
        parts.join(", ")
    } else {
        usage_name.unwrap_or_default()
    };
    let property_type = if value.is_empty() { "null" } else { "string" };
    let values = if values.is_empty() { None } else { Some(values) };
    (value, property_type.into(), None, values)
}

/// Stringify one member of an enumerated / list value, mirroring the WASM
/// `String(v)` / `String(v[1])`: a typed wrapper `List([type, inner])` yields
/// the inner, a scalar yields itself. `None` for nulls (dropped, like the TS
/// `.filter(v => v !== 'null')`).
fn stringify_member(v: &AttributeValue) -> Option<String> {
    match v {
        AttributeValue::List(items) if items.len() == 2 => stringify_scalar(&items[1]),
        other => stringify_scalar(other),
    }
}

fn stringify_scalar(v: &AttributeValue) -> Option<String> {
    match v {
        AttributeValue::String(s) => Some(s.clone()),
        AttributeValue::Enum(e) => Some(e.clone()),
        AttributeValue::Integer(i) => Some(i.to_string()),
        AttributeValue::Float(f) => Some(fmt_number(*f)),
        _ => None,
    }
}

/// Stringified members of a `List(...)` attribute (the WASM candidate array
/// before joining), or `None` when the attribute is not a list or every
/// member filters out — the display and the `values` wire field both derive
/// from this, so they can never disagree.
pub(super) fn member_list(attr: Option<&AttributeValue>) -> Option<Vec<String>> {
    match attr {
        Some(AttributeValue::List(items)) => {
            let parts: Vec<String> = items.iter().filter_map(stringify_member).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts)
            }
        }
        _ => None,
    }
}

/// The IFC type tag of a typed-wrapper attribute (`List([String(type), _])`),
/// upper-cased — mirrors the WASM `inferDataType`.
pub(super) fn infer_data_type(attr: Option<&AttributeValue>) -> Option<String> {
    match attr {
        Some(AttributeValue::List(items)) if items.len() == 2 => match &items[0] {
            AttributeValue::String(s) => Some(s.to_uppercase()),
            _ => None,
        },
        _ => None,
    }
}

/// Normalise an `.ENUM.`-style logical/boolean token (dots already stripped to
/// the inner letter by the tokenizer, e.g. `Enum("T")`; or a bare `String`).
fn logical_token(v: &AttributeValue) -> Option<&str> {
    v.as_enum()
        .or_else(|| v.as_string())
        .map(|s| s.trim_matches('.'))
}

/// Resolve an `IfcPropertySingleValue` NominalValue → (value string, kind, data_type),
/// matching `parsePropertyValue`'s single-value branch exactly.
pub(super) fn resolve_single_value(nominal: &AttributeValue) -> (String, String, Option<String>) {
    // Typed wrapper: List([String(typeName), inner]) — the common conformant case.
    if let AttributeValue::List(items) = nominal {
        if items.len() == 2 {
            if let AttributeValue::String(type_name) = &items[0] {
                let ty = type_name.to_uppercase();
                let inner = &items[1];

                if ty.contains("BOOLEAN") {
                    let b = logical_token(inner) == Some("T");
                    return (b.to_string(), "boolean".into(), Some(ty));
                }
                if ty.contains("LOGICAL") {
                    return match logical_token(inner) {
                        Some("U") | Some("X") => (String::new(), "logical".into(), Some(ty)),
                        Some("T") => ("true".into(), "logical".into(), Some(ty)),
                        _ => ("false".into(), "logical".into(), Some(ty)),
                    };
                }
                if let Some(n) = inner.as_float() {
                    // Preserve the IFC-declared numeric kind rather than
                    // re-inferring from the JS/Rust number-ness.
                    let kind = if ty == "IFCINTEGER" || ty == "IFCCOUNTMEASURE" {
                        "integer"
                    } else if ty == "IFCREAL" || ty.ends_with("MEASURE") || ty.ends_with("RATIO") {
                        "real"
                    } else if n.fract() == 0.0 {
                        "integer"
                    } else {
                        "real"
                    };
                    return (fmt_number(n), kind.into(), Some(ty));
                }
                // String inner (IFCLABEL/IFCTEXT/IFCIDENTIFIER/...).
                if let Some(s) = inner.as_string() {
                    return (s.to_string(), "string".into(), Some(ty));
                }
                if let Some(e) = inner.as_enum() {
                    return (e.to_string(), "string".into(), Some(ty));
                }
            }
        }
    }

    // Untyped scalars.
    match nominal {
        AttributeValue::Integer(i) => (i.to_string(), "integer".into(), None),
        AttributeValue::Float(f) => {
            let kind = if f.fract() == 0.0 { "integer" } else { "real" };
            (fmt_number(*f), kind.into(), None)
        }
        AttributeValue::String(s) => (s.clone(), "string".into(), None),
        // Bare enum tokens some authoring tools emit directly in the value slot.
        AttributeValue::Enum(e) => match e.trim_matches('.') {
            "T" => ("true".into(), "boolean".into(), None),
            "F" => ("false".into(), "boolean".into(), None),
            "U" | "X" => (String::new(), "logical".into(), None),
            other => (other.to_string(), "string".into(), None),
        },
        AttributeValue::Null | AttributeValue::Derived => (String::new(), "null".into(), None),
        // Anything else (nested list, ref) — stringify defensively.
        other => (format!("{:?}", other), "string".into(), None),
    }
}

/// Render a number the way JS `String(n)` would for the canonical value string
/// (integers without a trailing `.0`, so `200.0` -> "200").
pub(super) fn fmt_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}
