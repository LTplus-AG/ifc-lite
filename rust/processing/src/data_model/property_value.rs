// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property VALUE resolution: turning a decoded `IfcProperty` attribute
//! (nominal value, enumerated/list members, complex-property nesting) into
//! the display string + kind + measure tag + candidate list that
//! `properties::extract_property` wires onto a `Property`. Split out of
//! `properties.rs` to keep entity-shape extraction (which pset/property to
//! walk) separate from value-shape resolution (how to stringify one).

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, Logical, SchemaVersion};
use ifc_lite_core::limits::{
    complex_property_depth_marker, ComplexPropertyBudget, COMPLEX_PROPERTY_BUDGET_MARKER,
    MAX_COMPLEX_PROPERTY_DEPTH,
};

/// What an `IfcPropertyReferenceValue` reads as (#5475): the referenced
/// object's `Name`, else its `Identification` (an external reference, a
/// person), else `#<id>` so the property still reads as present. Mirrors
/// `resolvePropertyReferenceValue` in
/// `packages/parser/src/property-reference-value.ts`.
pub(super) fn property_reference_label(decoder: &mut EntityDecoder, id: u32) -> String {
    let label = decoder.decode_by_id(id).ok().and_then(|target| {
        ["Name", "Identification"].iter().find_map(|attribute| {
            let index = SchemaVersion::Ifc4x3
                .attribute(target.ifc_type.as_str(), attribute)?
                .index;
            target
                .get_string(index)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
        })
    });
    label.unwrap_or_else(|| format!("#{id}"))
}

/// Resolve an `IfcComplexProperty`'s nested `HasProperties` (EXPRESS:
/// `[Name, Description, UsageName, HasProperties]`, index 3) into a display
/// value plus a flat `values` candidate list, recursing into any further
/// nested `IfcComplexProperty` — mirrors `resolveComplexPropertyValue`
/// (`packages/parser/src/property-complex-value.ts`) member-for-member:
///
/// - Not a list, or an empty list: return the bare `UsageName` (or the "null"
///   kind when it's absent/empty) — there was nothing nested to lose.
/// - The depth cap is hit with a NON-EMPTY `HasProperties` still unread:
///   return `UsageName` suffixed with
///   `complex_property_depth_marker()`, or the bare marker when there is
///   no `UsageName`. Never the bare `UsageName`: that is a plausible,
///   well-formed value indistinguishable from a complex property that
///   genuinely has no nested content (issue #3972). The empty-`UsageName`
///   case matters most — before #3972 it produced an empty display, the
///   parent `continue`d past it, and the whole nested member vanished while
///   the parent fell back to showing its OWN `UsageName`, so the reader saw
///   a real value attributed to the wrong nesting level.
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
/// - Every bound, marker and charge is `ifc_lite_core::limits`' (#7675),
///   shared with the exporter's copy and mirrored by the TS twin: the depth
///   cap marks a cut with `complex_property_depth_marker()`, and `budget`
///   (member visits per top-level property, output bytes per model) cuts a
///   level with its parts so far plus `COMPLEX_PROPERTY_BUDGET_MARKER`, which
///   also ends that level's `values`.
pub(super) fn resolve_complex_property_value(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    budget: &mut ComplexPropertyBudget,
) -> (String, String, Option<String>, Option<Vec<String>>) {
    budget.start_property();
    resolve_complex(entity, decoder, 0, budget)
}

fn resolve_complex(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    depth: usize,
    budget: &mut ComplexPropertyBudget,
) -> (String, String, Option<String>, Option<Vec<String>>) {
    let usage_name = entity.get_string(2).map(|s| s.to_string());
    let bare = |usage_name: Option<String>| match usage_name {
        Some(u) if !u.is_empty() => (u, "string".to_string(), None, None),
        _ => (String::new(), "null".to_string(), None, None),
    };

    let has_properties = match entity.get_list(3) {
        Some(list) if !list.is_empty() => list,
        // Absent, not a list, or empty: nothing nested exists, so stopping
        // here loses nothing and must NOT be marked as a truncation.
        _ => return bare(usage_name),
    };

    if depth >= MAX_COMPLEX_PROPERTY_DEPTH {
        // Members were present and we declined to read them. Say so.
        let marker = complex_property_depth_marker();
        let value = match usage_name {
            Some(u) if !u.is_empty() => format!("{u} {marker}"),
            _ => marker,
        };
        return (value, "string".into(), None, None);
    }

    let refs: Vec<u32> = has_properties
        .iter()
        .filter_map(|v| v.as_entity_ref())
        .collect();

    let mut parts: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    let mut cut = false;

    for prop_id in refs {
        if !budget.admit_member() {
            cut = true;
            break;
        }
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
            resolve_complex(&nested_entity, decoder, depth + 1, budget).0
        } else {
            super::properties::member_display(&nested_entity, decoder)
        };
        // Every charge is the shared budget's, at the same point as the
        // exporter and TS walks (#7675).
        let Some(part) = budget.member_part(&nested_name, &display) else { continue };
        parts.push(part);
        values.push(display);
    }

    let value = budget.level_value(&parts, cut).unwrap_or_else(|| usage_name.unwrap_or_default());
    if cut {
        // The candidate list says it was cut, so a member past the cut does
        // not read as absent (#7675 D3).
        values.push(COMPLEX_PROPERTY_BUDGET_MARKER.to_string());
    }
    let property_type = if value.is_empty() { "null" } else { "string" };
    let values = if values.is_empty() { None } else { Some(values) };
    (value, property_type.into(), None, values)
}

/// A repeat listing `ComplexPropertyBudget::listing` refused: a cut level
/// with no parts, its `values` the marker alone (#7675 D3).
pub(super) fn spent_listing() -> (String, String, Option<String>, Option<Vec<String>>) {
    let marker = COMPLEX_PROPERTY_BUDGET_MARKER.to_string();
    (marker.clone(), "string".into(), None, Some(vec![marker]))
}

/// Stringify one member of an enumerated / list value, mirroring the WASM
/// `String(v)` / `String(v[1])`: a typed wrapper yields its value, a scalar
/// yields itself. `None` for nulls (dropped, like the TS
/// `.filter(v => v !== 'null')`).
fn stringify_member(v: &AttributeValue) -> Option<String> {
    stringify_scalar(v.unwrap_typed())
}

fn stringify_scalar(v: &AttributeValue) -> Option<String> {
    match v {
        AttributeValue::String(s) | AttributeValue::Binary(s) => Some(s.clone()),
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

/// The IFC type every member of a list attribute shares (`IFCLABEL` for
/// `(IFCLABEL('X'),IFCLABEL('Y'))`), or `None` when a member is untyped or the
/// types differ. Mirrors the WASM `sharedMemberType` (#5224).
pub(super) fn shared_member_type(attr: Option<&AttributeValue>) -> Option<String> {
    let AttributeValue::List(items) = attr? else {
        return None;
    };
    let mut shared: Option<String> = None;
    for item in items {
        let t = infer_data_type(Some(item))?;
        match &shared {
            Some(s) if *s != t => return None,
            _ => shared = Some(t),
        }
    }
    shared
}

/// The IFC type tag of a typed-wrapper attribute (`IFCLABEL('x')`),
/// upper-cased — mirrors the WASM `inferDataType`.
pub(super) fn infer_data_type(attr: Option<&AttributeValue>) -> Option<String> {
    attr?.as_typed().map(|(name, _)| name.to_uppercase())
}

/// A logical/boolean value: an enumeration (`Enum("T")`, the tokenizer strips
/// the dots) or, as some authoring tools write it, a bare string (`'T'`,
/// `'.U.'`). Core owns the table (`.U.` and `.X.` are unknown).
fn logical_of(v: &AttributeValue) -> Option<Logical> {
    v.as_logical().or_else(|| {
        let text = v.as_string()?.trim_matches('.');
        AttributeValue::Enum(text.to_owned()).as_logical()
    })
}

/// Resolve an `IfcPropertySingleValue` NominalValue → (value string, kind, data_type),
/// matching `parsePropertyValue`'s single-value branch exactly.
pub(super) fn resolve_single_value(nominal: &AttributeValue) -> (String, String, Option<String>) {
    // Typed wrapper, `IFCLABEL('x')` — the common conformant case.
    if let AttributeValue::Typed { name: type_name, value: inner } = nominal {
        let ty = type_name.to_uppercase();
        let inner = &**inner;

        if ty.contains("BOOLEAN") {
            let b = logical_of(inner) == Some(Logical::True);
            return (b.to_string(), "boolean".into(), Some(ty));
        }
        if ty.contains("LOGICAL") {
            return match logical_of(inner) {
                Some(Logical::Unknown) => (String::new(), "logical".into(), Some(ty)),
                Some(Logical::True) => ("true".into(), "logical".into(), Some(ty)),
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

    // Untyped scalars.
    match nominal {
        AttributeValue::Integer(i) => (i.to_string(), "integer".into(), None),
        AttributeValue::Float(f) => {
            let kind = if f.fract() == 0.0 { "integer" } else { "real" };
            (fmt_number(*f), kind.into(), None)
        }
        AttributeValue::String(s) | AttributeValue::Binary(s) => (s.clone(), "string".into(), None),
        // Bare enum tokens some authoring tools emit directly in the value slot.
        AttributeValue::Enum(e) => match nominal.as_logical() {
            Some(Logical::True) => ("true".into(), "boolean".into(), None),
            Some(Logical::False) => ("false".into(), "boolean".into(), None),
            Some(Logical::Unknown) => (String::new(), "logical".into(), None),
            None => (e.trim_matches('.').to_string(), "string".into(), None),
        },
        AttributeValue::Null | AttributeValue::Derived => (String::new(), "null".into(), None),
        // Anything else (nested list, ref) — stringify defensively.
        other => (format!("{:?}", other), "string".into(), None),
    }
}

/// The canonical value string for a number (`200.0` -> "200"): the shared
/// formatter, so the server and the exporters cannot disagree.
pub(super) use ifc_lite_core::fmt_num::fmt_num as fmt_number;

#[cfg(test)]
#[path = "property_value_tests.rs"]
mod tests;
