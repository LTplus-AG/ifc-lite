// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property set extraction.

use super::property_value::{
    fmt_number, infer_data_type, member_list, property_reference_label, shared_member_type, resolve_complex_property_value,
    resolve_single_value, spent_listing,
};
use ifc_lite_core::limits::{complex_property_listing_bytes, ComplexPropertyBudget};
use ifc_lite_core::IfcType;
use super::types::{EntityJob, Property, PropertySet};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

/// Extract all property sets and their properties.
pub(super) fn extract_properties(
    jobs: &[EntityJob],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<PropertySet> {
    // First, collect all PropertySet entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    // A set id is read once, at its LAST record: the one core's entity index
    // resolves the id to (keep-last, #7682), as the exporter's index and the
    // browser's store pass read it. An earlier record with the id is not a
    // set, so it neither adds a second set nor spends the complex-property
    // budget twice (#7675).
    let pset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCPROPERTYSET"))
        .filter(|job| entity_index.get(&job.id).is_some_and(|&(start, _)| start == job.start))
        .collect();

    tracing::debug!(count = pset_jobs.len(), "Extracting property sets");

    let mut sets: Vec<(PropertySet, Vec<(usize, u32)>)> = pset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content, entity_index.clone());
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
            let mut complex = Vec::new();

            // Extract properties from HasProperties list
            for prop_ref in has_properties.iter() {
                if let Some(prop_id) = prop_ref.as_entity_ref() {
                    if let Ok(prop_entity) = local_decoder.decode_by_id_lossless(prop_id) {
                        if let Some(prop) = extract_property(&prop_entity, &mut local_decoder) {
                            if prop_entity.ifc_type == IfcType::IfcComplexProperty {
                                complex.push((properties.len(), prop_id));
                            }
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

            Some((
                PropertySet {
                    pset_id: job.id,
                    pset_name,
                    properties,
                },
                complex,
            ))
        })
        .collect();
    resolve_complex_properties(&mut sets, content, entity_index);
    sets.into_iter().map(|(set, _)| set).collect()
}

/// Resolve every `IfcComplexProperty` the parallel pass left empty, in set
/// order, against ONE output budget for the whole model
/// (`complex_property_output_budget`, relative to the input). A per-property
/// budget is not enough, because a set can list the same complex property
/// many times (#7675). The order is file order, the same order the exporter
/// and the browser resolve in, so the property the budget cuts is the same on
/// every run and in every copy. Real models carry few complex properties, so
/// the pass is sequential.
fn resolve_complex_properties(
    sets: &mut [(PropertySet, Vec<(usize, u32)>)],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) {
    if sets.iter().all(|(_, complex)| complex.is_empty()) {
        return;
    }
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let mut budget = ComplexPropertyBudget::for_input(content.len());
    // Walked once per complex property id; a repeat listing reuses the value,
    // charged what it keeps (`ComplexPropertyBudget::listing`).
    let mut memo = HashMap::new();
    for (set, complex) in sets.iter_mut() {
        for &(index, prop_id) in complex.iter() {
            let Ok(entity) = decoder.decode_by_id(prop_id) else { continue };
            let (value, kind, data_type, values) = budget.listing(
                &mut memo,
                prop_id,
                |budget| {
                    let resolved = resolve_complex_property_value(&entity, &mut decoder, budget);
                    let bytes = complex_property_listing_bytes(&resolved.0, resolved.3.as_deref().unwrap_or_default());
                    (resolved, bytes)
                },
                spent_listing,
            );
            let property = &mut set.properties[index];
            property.property_value = value;
            property.property_type = kind;
            property.data_type = data_type;
            property.values = values;
        }
    }
    if budget.cuts() > 0 {
        tracing::warn!(
            cuts = budget.cuts(),
            input_bytes = content.len(),
            "IfcComplexProperty values cut by the walk budget (#7675); each cut value ends with its marker"
        );
    }
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
    // All IfcProperty subtypes carry Name at attribute 0.
    let property_name = entity.get_string(0)?.to_string();
    read_property(entity, decoder, property_name)
}

/// The display value of a non-complex member of an `IfcComplexProperty`,
/// read whether or not it has a `Name` (empty when it has no value): the
/// browser's walk and the exporter's read an unnamed member's value and
/// charge it, so this one does too (#7675). It shows as a bare part.
pub(super) fn member_display(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> String {
    read_property(entity, decoder, String::new()).map(|p| p.property_value).unwrap_or_default()
}

fn read_property(entity: &DecodedEntity, decoder: &mut EntityDecoder, property_name: String) -> Option<Property> {
    use ifc_lite_core::AttributeValue;
    let ty = entity.ifc_type.as_str().to_uppercase();

    // `values` mirrors the WASM `parsePropertyValue().values` candidate array
    // (issue #1766): IDS facet checks pass when ANY candidate matches. Emitted
    // only when non-empty — the client treats an empty array as absent.
    let mut data_type_mixed = false;
    let (property_value, property_type, data_type, values) = match ty.as_str() {
        // [Name, Description, NominalValue, Unit]
        "IFCPROPERTYSINGLEVALUE" => {
            let (v, k, d) = resolve_single_value(entity.get(2)?);
            (v, k, d, None)
        }

        // [Name, Description, EnumerationValues (list), EnumerationReference]
        // Carries the one type its members share (#5224).
        "IFCPROPERTYENUMERATEDVALUE" => {
            let members = member_list(entity.get(2));
            let joined = members.as_ref().map(|m| m.join(", ")).unwrap_or_default();
            (joined, "string".into(), shared_member_type(entity.get(2)), members)
        }

        // [Name, Description, ListValues (list), Unit]
        "IFCPROPERTYLISTVALUE" => {
            let members = member_list(entity.get(2));
            let joined = members.as_ref().map(|m| m.join(", ")).unwrap_or_default();
            (joined, "string".into(), shared_member_type(entity.get(2)), members)
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
                data_type_mixed = true;
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

        // [Name, Description, UsageName, PropertyReference]: the reference is
        // slot 3 in IFC2X3, IFC4 and IFC4X3 alike (#5475).
        "IFCPROPERTYREFERENCEVALUE" => match entity.get(3).and_then(|v| v.as_entity_ref()) {
            Some(id) => (property_reference_label(decoder, id), "string".into(), None, None),
            None => (String::new(), "null".into(), None, None),
        },

        // [Name, Description, UsageName, HasProperties] — issue #3963. Mirrors
        // `resolveComplexPropertyValue` in
        // packages/parser/src/property-complex-value.ts, which IS the spec:
        // flatten each resolvable nested property into a "Name: value" part,
        // join with ", ", and fall back to the bare UsageName (or nothing)
        // when no nested member resolves. Recurses into further nested
        // IFCCOMPLEXPROPERTY members up to the same depth cap as the TS side.
        //
        // Resolved by `resolve_complex_properties` after the parallel pass, in
        // set order, so the shared output budget cuts the same property on
        // every run (#7675). Until then the value is empty.
        "IFCCOMPLEXPROPERTY" => (String::new(), "null".into(), None, None),

        _ => return None,
    };

    Some(Property {
        property_name,
        property_value,
        property_type,
        data_type,
        data_type_mixed,
        values,
    })
}
