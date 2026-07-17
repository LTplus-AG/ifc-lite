// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property set extraction.

use super::types::{EntityJob, Property, PropertySet};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Extract all property sets and their properties.
pub(super) fn extract_properties(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<PropertySet> {
    // First, collect all PropertySet entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let pset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCPROPERTYSET"))
        .collect();

    tracing::debug!(count = pset_jobs.len(), "Extracting property sets");

    pset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            // IfcPropertySet: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=HasProperties
            let pset_name = entity.get_string(2)?.to_string();
            let has_properties = entity.get_list(4)?;

            let mut properties = Vec::new();

            // Extract properties from HasProperties list
            for prop_ref in has_properties.iter() {
                if let Some(prop_id) = prop_ref.as_entity_ref() {
                    if let Ok(prop_entity) = local_decoder.decode_by_id(prop_id) {
                        if let Some(prop) = extract_property(&prop_entity, &mut local_decoder) {
                            properties.push(prop);
                        }
                    }
                }
            }

            if properties.is_empty() {
                return None;
            }

            Some(PropertySet {
                pset_id: job.id,
                pset_name,
                properties,
            })
        })
        .collect()
}

/// Extract a single property from IfcProperty entity.
///
/// Mirrors the WASM path's `parsePropertyValue`
/// (`packages/parser/src/on-demand-extractors.ts`) so server-parsed properties
/// carry the SAME resolved value + kind + measure tag as the in-browser parse.
/// STEP wraps values as typed tokens (`IFCLABEL('X')`, `IFCBOOLEAN(.T.)`), which
/// the decoder stores as `AttributeValue::List([String(type), inner])`; the old
/// code only matched bare `String`/`Float` and emitted `format!("{:?}")` Debug
/// garbage for every text/boolean value — this resolves them properly.
fn extract_property(entity: &DecodedEntity, _decoder: &mut EntityDecoder) -> Option<Property> {
    use ifc_lite_core::AttributeValue;
    // All IfcProperty subtypes carry Name at attribute 0.
    let property_name = entity.get_string(0)?.to_string();
    let ty = entity.ifc_type.as_str().to_uppercase();

    let (property_value, property_type, data_type) = match ty.as_str() {
        // [Name, Description, NominalValue, Unit]
        "IFCPROPERTYSINGLEVALUE" => resolve_single_value(entity.get(2)?),

        // [Name, Description, EnumerationValues (list), EnumerationReference]
        "IFCPROPERTYENUMERATEDVALUE" => {
            let joined = join_member_list(entity.get(2));
            (joined.unwrap_or_default(), "string".into(), None)
        }

        // [Name, Description, ListValues (list), Unit]
        "IFCPROPERTYLISTVALUE" => {
            let joined = join_member_list(entity.get(2));
            (joined.unwrap_or_default(), "string".into(), None)
        }

        // [Name, Description, UpperBoundValue, LowerBoundValue, Unit, SetPointValue]
        "IFCPROPERTYBOUNDEDVALUE" => {
            let upper = entity.get(2).and_then(|v| v.as_float());
            let lower = entity.get(3).and_then(|v| v.as_float());
            let set_point = entity.get(5).and_then(|v| v.as_float());
            let display_value = set_point.or(upper).or(lower);
            match display_value {
                None => (String::new(), "null".into(), None),
                Some(dv) => {
                    let mut display = fmt_number(dv);
                    if let (Some(lo), Some(hi)) = (lower, upper) {
                        // en-dash to match the WASM display exactly.
                        display.push_str(&format!(
                            " [{} \u{2013} {}]",
                            fmt_number(lo),
                            fmt_number(hi)
                        ));
                    }
                    let data_type = infer_data_type(entity.get(5))
                        .or_else(|| infer_data_type(entity.get(2)))
                        .or_else(|| infer_data_type(entity.get(3)));
                    // The value is a display STRING ("5 [2 – 8]"), so keep kind
                    // `string` — a `real` kind would make the client `Number()`
                    // it to NaN. The Lists cell derives from the value, and the
                    // measure tag still rides on `data_type`.
                    (display, "string".into(), data_type)
                }
            }
        }

        // [Name, Description, DefiningValues (list), DefinedValues (list), ...]
        "IFCPROPERTYTABLEVALUE" => {
            let rows = match entity.get(2) {
                Some(AttributeValue::List(items)) => items.len(),
                _ => 0,
            };
            if rows > 0 {
                (format!("Table ({} rows)", rows), "string".into(), None)
            } else {
                (String::new(), "null".into(), None)
            }
        }

        // [Name, Description, PropertyReference]
        "IFCPROPERTYREFERENCEVALUE" => match entity.get(2).and_then(|v| v.as_entity_ref()) {
            Some(id) => (format!("#{}", id), "string".into(), None),
            None => (String::new(), "null".into(), None),
        },

        _ => return None,
    };

    Some(Property {
        property_name,
        property_value,
        property_type,
        data_type,
    })
}

/// Stringify one member of an enumerated / list value, mirroring the WASM
/// `String(v)` / `String(v[1])`: a typed wrapper `List([type, inner])` yields
/// the inner, a scalar yields itself. `None` for nulls (dropped, like the TS
/// `.filter(v => v !== 'null')`).
fn stringify_member(v: &ifc_lite_core::AttributeValue) -> Option<String> {
    use ifc_lite_core::AttributeValue;
    match v {
        AttributeValue::List(items) if items.len() == 2 => stringify_scalar(&items[1]),
        other => stringify_scalar(other),
    }
}

fn stringify_scalar(v: &ifc_lite_core::AttributeValue) -> Option<String> {
    use ifc_lite_core::AttributeValue;
    match v {
        AttributeValue::String(s) => Some(s.clone()),
        AttributeValue::Enum(e) => Some(e.clone()),
        AttributeValue::Integer(i) => Some(i.to_string()),
        AttributeValue::Float(f) => Some(fmt_number(*f)),
        _ => None,
    }
}

/// Join a `List(...)` attribute's members with ", " (WASM `values.join(', ')`),
/// or `None` when the attribute is not a non-empty list.
fn join_member_list(attr: Option<&ifc_lite_core::AttributeValue>) -> Option<String> {
    use ifc_lite_core::AttributeValue;
    match attr {
        Some(AttributeValue::List(items)) => {
            let parts: Vec<String> = items.iter().filter_map(stringify_member).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(", "))
            }
        }
        _ => None,
    }
}

/// The IFC type tag of a typed-wrapper attribute (`List([String(type), _])`),
/// upper-cased — mirrors the WASM `inferDataType`.
fn infer_data_type(attr: Option<&ifc_lite_core::AttributeValue>) -> Option<String> {
    use ifc_lite_core::AttributeValue;
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
fn logical_token(v: &ifc_lite_core::AttributeValue) -> Option<&str> {
    v.as_enum()
        .or_else(|| v.as_string())
        .map(|s| s.trim_matches('.'))
}

/// Resolve an `IfcPropertySingleValue` NominalValue → (value string, kind, data_type),
/// matching `parsePropertyValue`'s single-value branch exactly.
fn resolve_single_value(
    nominal: &ifc_lite_core::AttributeValue,
) -> (String, String, Option<String>) {
    use ifc_lite_core::AttributeValue;

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
fn fmt_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}
