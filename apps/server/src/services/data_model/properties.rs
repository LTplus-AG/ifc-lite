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

            // A PropertySet with a real Name is real evidence the file links
            // this element to it, even when every member failed to resolve
            // (issue #3963): dropping it wholesale is indistinguishable from
            // "this element was never linked to any pset via
            // IfcRelDefinesByProperties" in the first place. Mirrors the
            // browser/WASM path's keep condition (`columnar-parser.ts`:
            // `properties.length > 0 || psetName`) — only an unnamed,
            // fully-unresolved set is dropped.
            if properties.is_empty() && pset_name.is_empty() {
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
fn extract_property(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Property> {
    use ifc_lite_core::AttributeValue;
    // All IfcProperty subtypes carry Name at attribute 0.
    let property_name = entity.get_string(0)?.to_string();
    let ty = entity.ifc_type.as_str().to_uppercase();

    // `values` mirrors the WASM `parsePropertyValue().values` candidate array
    // (issue #1766): IDS facet checks pass when ANY candidate matches. Emitted
    // only when non-empty — the client treats an empty array as absent.
    let (property_value, property_type, data_type, values) = match ty.as_str() {
        // [Name, Description, NominalValue, Unit]
        "IFCPROPERTYSINGLEVALUE" => {
            let (v, k, d) = resolve_single_value(entity.get(2)?);
            (v, k, d, None)
        }

        // [Name, Description, EnumerationValues (list), EnumerationReference]
        "IFCPROPERTYENUMERATEDVALUE" => {
            let members = member_list(entity.get(2));
            let joined = members.as_ref().map(|m| m.join(", ")).unwrap_or_default();
            (joined, "string".into(), None, members)
        }

        // [Name, Description, ListValues (list), Unit]
        "IFCPROPERTYLISTVALUE" => {
            let members = member_list(entity.get(2));
            let joined = members.as_ref().map(|m| m.join(", ")).unwrap_or_default();
            (joined, "string".into(), None, members)
        }

        // [Name, Description, UpperBoundValue, LowerBoundValue, Unit, SetPointValue]
        "IFCPROPERTYBOUNDEDVALUE" => {
            let upper = entity.get(2).and_then(|v| v.as_float());
            let lower = entity.get(3).and_then(|v| v.as_float());
            let set_point = entity.get(5).and_then(|v| v.as_float());
            let display_value = set_point.or(upper).or(lower);
            match display_value {
                None => (String::new(), "null".into(), None, None),
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
                    // Every defined bound is a candidate, deduped exactly like
                    // the WASM side: lower always; upper unless == lower;
                    // setPoint unless it equals either bound.
                    let mut candidates: Vec<String> = Vec::new();
                    if let Some(lo) = lower {
                        candidates.push(fmt_number(lo));
                    }
                    if let Some(hi) = upper {
                        if Some(hi) != lower {
                            candidates.push(fmt_number(hi));
                        }
                    }
                    if let Some(sp) = set_point {
                        if Some(sp) != lower && Some(sp) != upper {
                            candidates.push(fmt_number(sp));
                        }
                    }
                    let values = if candidates.is_empty() {
                        None
                    } else {
                        Some(candidates)
                    };
                    // The value is a display STRING ("5 [2 – 8]"), so keep kind
                    // `string` — a `real` kind would make the client `Number()`
                    // it to NaN. The Lists cell derives from the value, and the
                    // measure tag still rides on `data_type`.
                    (display, "string".into(), data_type, values)
                }
            }
        }

        // [Name, Description, DefiningValues (list), DefinedValues (list), ...]
        "IFCPROPERTYTABLEVALUE" => {
            // Mirror the WASM gate exactly: BOTH DefiningValues and DefinedValues
            // must be lists (else the whole property resolves to null) — a
            // malformed table with `$` DefinedValues must not fabricate a
            // display/candidates that only the server would match.
            let rows = match entity.get(2) {
                Some(AttributeValue::List(items)) => items.len(),
                _ => 0,
            };
            let defined_is_list = matches!(entity.get(3), Some(AttributeValue::List(_)));
            if rows > 0 && defined_is_list {
                // Candidates are defining THEN defined values, both filtered —
                // matching the WASM table branch's ordering.
                let mut members = member_list(entity.get(2)).unwrap_or_default();
                members.extend(member_list(entity.get(3)).unwrap_or_default());
                let values = if members.is_empty() {
                    None
                } else {
                    Some(members)
                };
                (
                    format!("Table ({} rows)", rows),
                    "string".into(),
                    None,
                    values,
                )
            } else {
                (String::new(), "null".into(), None, None)
            }
        }

        // [Name, Description, PropertyReference]
        "IFCPROPERTYREFERENCEVALUE" => match entity.get(2).and_then(|v| v.as_entity_ref()) {
            Some(id) => (format!("#{}", id), "string".into(), None, None),
            None => (String::new(), "null".into(), None, None),
        },

        // [Name, Description, UsageName, HasProperties] — issue #3963. Mirrors
        // `resolveComplexPropertyValue` in
        // packages/parser/src/property-value-parser.ts, which IS the spec:
        // flatten each resolvable nested property into a "Name: value" part,
        // join with ", ", and fall back to the bare UsageName (or nothing)
        // when no nested member resolves. Recurses into further nested
        // IFCCOMPLEXPROPERTY members up to the same depth cap as the TS side.
        "IFCCOMPLEXPROPERTY" => {
            let (v, k, d, vs) = resolve_complex_property_value(entity, decoder, 0);
            (v, k, d, vs)
        }

        _ => return None,
    };

    Some(Property {
        property_name,
        property_value,
        property_type,
        data_type,
        values,
    })
}

/// Guards `resolve_complex_property_value` against a pathological/cyclic
/// `HasProperties` chain, mirroring the TS `MAX_COMPLEX_PROPERTY_DEPTH` in
/// `packages/parser/src/property-value-parser.ts` exactly: real IFC nests
/// `IfcComplexProperty` at most a couple of levels deep.
const MAX_COMPLEX_PROPERTY_DEPTH: u8 = 8;

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
fn resolve_complex_property_value(
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
            match extract_property(&nested_entity, decoder) {
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

/// Stringified members of a `List(...)` attribute (the WASM candidate array
/// before joining), or `None` when the attribute is not a list or every
/// member filters out — the display and the `values` wire field both derive
/// from this, so they can never disagree.
fn member_list(attr: Option<&ifc_lite_core::AttributeValue>) -> Option<Vec<String>> {
    use ifc_lite_core::AttributeValue;
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
