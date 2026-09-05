// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property set extraction.

use super::property_value::{
    fmt_number, infer_data_type, member_list, resolve_complex_property_value, resolve_single_value,
};
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
            // `Name` is OPTIONAL per the schema (inherited from `IfcRoot`) —
            // bailing the whole closure with `?` on a null/non-string Name
            // would drop a pset with genuinely resolvable properties before
            // the keep condition below ever runs, breaking the exact parity
            // with the browser/WASM path's `typeof psetAttrs[2] === 'string'
            // ? psetAttrs[2] : ''` (`columnar-parser.ts`), which always
            // normalizes a missing Name to `''` rather than discarding the
            // pset. Mirror that here instead of using `?`.
            let pset_name = entity.get_string(2).unwrap_or_default().to_string();
            // `HasProperties` is a mandatory, non-empty SET per the schema, so
            // a `$`/malformed value here means the file itself is invalid —
            // but the browser path still tolerates it (`Array.isArray` check,
            // falling through with an empty `properties`) rather than
            // discarding the pset outright. Match that: treat a missing/
            // malformed list as empty rather than bailing on `?`.
            let has_properties = entity.get_list(4).unwrap_or(&[]);

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
pub(super) fn extract_property(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<Property> {
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
