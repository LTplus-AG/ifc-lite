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
    // IfcPropertySingleValue: [0]=Name, [1]=Description, [2]=NominalValue, [3]=Unit
    if !entity.ifc_type.as_str().eq_ignore_ascii_case("IFCPROPERTYSINGLEVALUE") {
        return None;
    }
    let property_name = entity.get_string(0)?.to_string();
    let nominal_value = entity.get(2)?;
    let (property_value, property_type, data_type) = resolve_single_value(nominal_value);
    Some(Property {
        property_name,
        property_value,
        property_type,
        data_type,
    })
}

/// Normalise an `.ENUM.`-style logical/boolean token (dots already stripped to
/// the inner letter by the tokenizer, e.g. `Enum("T")`; or a bare `String`).
fn logical_token(v: &ifc_lite_core::AttributeValue) -> Option<&str> {
    v.as_enum().or_else(|| v.as_string()).map(|s| s.trim_matches('.'))
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
