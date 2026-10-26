// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical, order-independent data fingerprinting for model diffing.
//!
//! A byte-exact port of `packages/diff/src/fingerprint.ts`. Callers extract a
//! plain [`DataFingerprintInput`] from whatever store they have and hash it
//! here, so base and head adapters produce identical fingerprints for an
//! unchanged entity — across adapters, machines and now languages.
//!
//! The rules that are load-bearing rather than incidental, each of which the
//! TypeScript module argues for at length:
//!
//! - **An assigned type is identified by name and IFC class, never by
//!   `GlobalId`.** `IfcTypeObject` is an `IfcRoot`, so a from-scratch
//!   re-export regenerates its id; hashing it moved the fingerprint of every
//!   *typed* element on exactly the re-export where nothing substantive
//!   changed, defeating the content-matching pass that exists for that case.
//! - **`Tag` participates for type objects only.** For a type object it is
//!   design content and often the only discriminator between same-named
//!   types. For an occurrence it is the authoring tool's own element id, so
//!   two tools exporting one design disagree on it for every element.
//! - **Absent and empty hash alike** for materials and classifications: the
//!   key is omitted entirely when the projection is empty, so shipping those
//!   fields did not move the fingerprint of every material-less entity.
//! - **[`core_attributes`] is one function, not two literals.** The
//!   `attr:core` sub-hash is a collision *guard* on the whole-blob hash, and
//!   that only holds while the two project identically.

use crate::JsString;
use crate::sparse_collection::SparseCollection;

use crate::input::{DataFingerprintInput, PropertyEntryInput, PropertyValue, TypeAssignmentInput};
use crate::js_json::{cmp_sorted, non_finite_token, stringify_sorted, JsonValue};

#[path = "fingerprint_checked.rs"]
mod checked;
pub use checked::{
    build_component_fingerprint_entries, build_component_fingerprint_entries_checked,
    build_component_fingerprints, build_data_fingerprint, build_data_fingerprint_checked,
    check_property_sets, check_quantity_sets, check_type_assignments,
};

/// A normalized scalar: what a property value collapses to before hashing.
#[derive(Debug, Clone, PartialEq)]
enum NormalizedValue {
    Null,
    Bool(bool),
    /// Always finite — a non-finite input becomes [`NormalizedValue::String`].
    Number(f64),
    String(JsString),
}

impl NormalizedValue {
    fn to_json(&self) -> JsonValue {
        match self {
            NormalizedValue::Null => JsonValue::Null,
            NormalizedValue::Bool(value) => JsonValue::Bool(*value),
            NormalizedValue::Number(value) => JsonValue::Number(*value),
            NormalizedValue::String(value) => JsonValue::String(value.clone()),
        }
    }
}

/// Collapse a property value to a stable scalar.
///
/// Non-finite numbers become their `String(n)` token rather than reaching the
/// serializer, because `JSON.stringify` maps `NaN`/`Infinity`/`-Infinity` to
/// `null` — the same token an absent property produces. An `Infinity` value
/// (reachable from a STEP `IfcReal` with an extreme exponent) would otherwise
/// hash identically to the property being absent, and the content pass treats
/// an equal hash as identity, so that collision could retire a genuine
/// added/deleted pair as unchanged.
///
/// Composite values are serialized with **sorted** keys, so two structurally
/// equal values hash alike regardless of key insertion order.
fn normalize_value(value: &PropertyValue) -> NormalizedValue {
    match value {
        PropertyValue::Null => NormalizedValue::Null,
        PropertyValue::Bool(flag) => NormalizedValue::Bool(*flag),
        PropertyValue::Number(number) => {
            if number.is_finite() {
                NormalizedValue::Number(*number)
            } else {
                NormalizedValue::String(non_finite_token(*number).into())
            }
        }
        PropertyValue::String(text) => NormalizedValue::String(text.clone()),
        composite => NormalizedValue::String(stringify_sorted(&to_json_value(composite)).into()),
    }
}

/// Lift a raw adapter value into the serializer's value type, unchanged.
fn to_json_value(value: &PropertyValue) -> JsonValue {
    match value {
        PropertyValue::Null => JsonValue::Null,
        PropertyValue::Bool(flag) => JsonValue::Bool(*flag),
        PropertyValue::Number(number) => JsonValue::Number(*number),
        PropertyValue::String(text) => JsonValue::String(text.clone()),
        PropertyValue::Array(items) => {
            JsonValue::Array(items.iter().map(to_json_value).collect())
        }
        PropertyValue::Object(entries) => JsonValue::Object(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), to_json_value(item)))
                .collect(),
        ),
    }
}

/// A normalized, named record: the unit both sorted collections hold.
struct NamedEntry {
    name: JsString,
    value: NormalizedValue,
}

impl NamedEntry {
    fn to_json(&self) -> JsonValue {
        JsonValue::Object(vec![
            ("name".into(), JsonValue::String(self.name.clone())),
            ("value".into(), self.value.to_json()),
        ])
    }
}

/// Total order over named records: name first, then serialized content.
///
/// The name alone is **not** a total order, and the sorted result is hashed,
/// so ties would make the fingerprint depend on the order the adapter walked
/// its relationships in — same content, two orders, two hashes. Same-named
/// property sets are not hypothetical: a type pset and an occurrence pset of
/// one name is a normal IFC arrangement. Tiebreaking on serialized content
/// makes the order total and content-derived.
fn cmp_name_then_content(a: (&JsString, &JsonValue), b: (&JsString, &JsonValue)) -> std::cmp::Ordering {
    // Code-unit order of the two stableSerialize texts, hole runs compared
    // without materializing them (#8114).
    a.0.cmp(b.0).then_with(|| cmp_sorted(a.1, b.1))
}

fn sorted_entries(entries: &SparseCollection<PropertyEntryInput>) -> Vec<JsonValue> {
    let mut normalized: Vec<NamedEntry> = entries
        .present()
        .map(|entry| NamedEntry {
            name: entry.name.clone(),
            value: normalize_value(&entry.value),
        })
        .collect();
    normalized.sort_by(|a, b| {
        cmp_name_then_content((&a.name, &a.to_json()), (&b.name, &b.to_json()))
    });
    with_holes(normalized.into_iter().map(|entry| entry.to_json()).collect(), entries.holes())
}

/// The direct-attribute slice, in one place because two functions hash it and
/// they are required to hash the same thing.
fn core_attributes(input: &DataFingerprintInput) -> Vec<(JsString, JsonValue)> {
    let text = |value: &Option<JsString>| JsonValue::String(value.clone().unwrap_or_default());
    vec![
        ("Type".into(), JsonValue::String(input.ifc_type.clone())),
        ("Name".into(), text(&input.name)),
        ("Description".into(), text(&input.description)),
        ("ObjectType".into(), text(&input.object_type)),
        ("PredefinedType".into(), text(&input.predefined_type)),
        ("Tag".into(), text(&input.tag)),
    ]
}

/// A set's canonical JSON form: `{ name, <members-key>: [...] }`, in that
/// order, because the key order is part of the hashed format.
fn set_to_json(name: &JsString, members_key: &str, members: &[JsonValue]) -> JsonValue {
    JsonValue::Object(vec![
        ("name".into(), JsonValue::String(name.clone())),
        (
            members_key.into(),
            JsonValue::Array(members.to_vec()),
        ),
    ])
}

fn sorted_property_sets(input: &DataFingerprintInput) -> Vec<(JsString, JsonValue)> {
    let mut sets: Vec<(JsString, JsonValue)> = input
        .property_sets
        .present()
        .map(|set| {
            let members = sorted_entries(&set.properties);
            (set.name.clone(), set_to_json(&set.name, "properties", &members))
        })
        .collect();
    sets.sort_by(|a, b| cmp_name_then_content((&a.0, &a.1), (&b.0, &b.1)));
    sets
}

fn sorted_quantity_sets(input: &DataFingerprintInput) -> Vec<(JsString, JsonValue)> {
    let mut sets: Vec<(JsString, JsonValue)> = input
        .quantity_sets
        .present()
        .map(|set| {
            let members = sorted_entries(&set.quantities);
            (set.name.clone(), set_to_json(&set.name, "quantities", &members))
        })
        .collect();
    sets.sort_by(|a, b| cmp_name_then_content((&a.0, &a.1), (&b.0, &b.1)));
    sets
}

/// Canonical projection of the assigned types: semantic identity only.
///
/// Sorted by (class, name). Those two fields are the whole projected record,
/// so two assignments tying on both are identical and their relative order
/// cannot affect the serialization — the sort is total on the output even
/// though it is not total on the input.
///
/// Duplicates are kept rather than collapsed: cardinality is content, and IFC
/// allows an occurrence at most one `IfcRelDefinesByType`, so two assignments
/// are an anomaly a diff should surface rather than normalize away.
fn sorted_type_assignments(types: &SparseCollection<TypeAssignmentInput>) -> Vec<JsonValue> {
    let mut projected: Vec<(JsString, JsString)> = types
        .present()
        .map(|assignment| {
            (
                assignment.name.clone().unwrap_or_default(),
                assignment.type_name.clone().unwrap_or_default(),
            )
        })
        .collect();
    projected.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    let values = projected
        .into_iter()
        .map(|(name, type_name)| {
            JsonValue::Object(vec![
                ("name".into(), JsonValue::String(name)),
                ("type".into(), JsonValue::String(type_name)),
            ])
        })
        .collect();
    with_holes(values, types.holes())
}

/// Sorting moves holes after the records; keep them as ONE trailing run.
fn with_holes(mut values: Vec<JsonValue>, holes: usize) -> Vec<JsonValue> {
    if holes > 0 { values.push(JsonValue::Holes(holes)); }
    values
}

fn string_array(values: &[JsString]) -> JsonValue {
    JsonValue::Array(values.iter().cloned().map(JsonValue::String).collect())
}

#[cfg(test)]
#[path = "fingerprint_sparse_tests.rs"]
mod sparse_tests;

#[cfg(test)]
#[path = "fingerprint_counted_tests.rs"]
mod counted_tests;
