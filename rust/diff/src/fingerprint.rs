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

use std::collections::BTreeMap;

use crate::input::{DataFingerprintInput, PropertyEntryInput, PropertyValue};
use crate::js_json::{non_finite_token, stringify, stringify_sorted, JsonValue};
use crate::projections::sorted_string_list;
use crate::utf16::{cmp_code_units, stable_hash};

/// A normalized scalar: what a property value collapses to before hashing.
#[derive(Debug, Clone, PartialEq)]
enum NormalizedValue {
    Null,
    Bool(bool),
    /// Always finite — a non-finite input becomes [`NormalizedValue::String`].
    Number(f64),
    String(String),
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
                NormalizedValue::String(non_finite_token(*number).to_owned())
            }
        }
        PropertyValue::String(text) => NormalizedValue::String(text.clone()),
        composite => NormalizedValue::String(stringify_sorted(&to_json_value(composite))),
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
    name: String,
    value: NormalizedValue,
}

impl NamedEntry {
    fn to_json(&self) -> JsonValue {
        JsonValue::Object(vec![
            ("name".to_owned(), JsonValue::String(self.name.clone())),
            ("value".to_owned(), self.value.to_json()),
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
fn cmp_name_then_content(a: (&str, &JsonValue), b: (&str, &JsonValue)) -> std::cmp::Ordering {
    cmp_code_units(a.0, b.0).then_with(|| {
        cmp_code_units(&stringify_sorted(a.1), &stringify_sorted(b.1))
    })
}

fn sorted_entries(entries: &[PropertyEntryInput]) -> Vec<NamedEntry> {
    let mut normalized: Vec<NamedEntry> = entries
        .iter()
        .map(|entry| NamedEntry {
            name: entry.name.clone(),
            value: normalize_value(&entry.value),
        })
        .collect();
    normalized.sort_by(|a, b| {
        cmp_name_then_content((&a.name, &a.to_json()), (&b.name, &b.to_json()))
    });
    normalized
}

/// The direct-attribute slice, in one place because two functions hash it and
/// they are required to hash the same thing.
fn core_attributes(input: &DataFingerprintInput) -> Vec<(String, JsonValue)> {
    let text = |value: &Option<String>| JsonValue::String(value.clone().unwrap_or_default());
    vec![
        ("Type".to_owned(), JsonValue::String(input.ifc_type.clone())),
        ("Name".to_owned(), text(&input.name)),
        ("Description".to_owned(), text(&input.description)),
        ("ObjectType".to_owned(), text(&input.object_type)),
        ("PredefinedType".to_owned(), text(&input.predefined_type)),
        ("Tag".to_owned(), text(&input.tag)),
    ]
}

/// A set's canonical JSON form: `{ name, <members-key>: [...] }`, in that
/// order, because the key order is part of the hashed format.
fn set_to_json(name: &str, members_key: &str, members: &[NamedEntry]) -> JsonValue {
    JsonValue::Object(vec![
        ("name".to_owned(), JsonValue::String(name.to_owned())),
        (
            members_key.to_owned(),
            JsonValue::Array(members.iter().map(NamedEntry::to_json).collect()),
        ),
    ])
}

fn sorted_property_sets(input: &DataFingerprintInput) -> Vec<(String, JsonValue)> {
    let mut sets: Vec<(String, JsonValue)> = input
        .property_sets
        .iter()
        .map(|set| {
            let members = sorted_entries(&set.properties);
            (set.name.clone(), set_to_json(&set.name, "properties", &members))
        })
        .collect();
    sets.sort_by(|a, b| cmp_name_then_content((&a.0, &a.1), (&b.0, &b.1)));
    sets
}

fn sorted_quantity_sets(input: &DataFingerprintInput) -> Vec<(String, JsonValue)> {
    let mut sets: Vec<(String, JsonValue)> = input
        .quantity_sets
        .iter()
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
fn sorted_type_assignments(input: &DataFingerprintInput) -> Vec<JsonValue> {
    let mut projected: Vec<(String, String)> = input
        .type_assignments
        .iter()
        .map(|assignment| {
            (
                assignment.name.clone().unwrap_or_default(),
                assignment.type_name.clone().unwrap_or_default(),
            )
        })
        .collect();
    projected.sort_by(|a, b| cmp_code_units(&a.1, &b.1).then_with(|| cmp_code_units(&a.0, &b.0)));
    projected
        .into_iter()
        .map(|(name, type_name)| {
            JsonValue::Object(vec![
                ("name".to_owned(), JsonValue::String(name)),
                ("type".to_owned(), JsonValue::String(type_name)),
            ])
        })
        .collect()
}

fn string_array(values: &[String]) -> JsonValue {
    JsonValue::Array(values.iter().cloned().map(JsonValue::String).collect())
}

/// Build the canonical data fingerprint for one entity.
///
/// Key order in the hashed object is part of the format: `Type`, `Name`,
/// `Description`, `ObjectType`, `PredefinedType`, `Tag`, `TypeAssignments`,
/// `PropertySets`, `QuantitySets`, then `Materials` and `Classifications`
/// **only when non-empty**.
pub fn build_data_fingerprint(input: &DataFingerprintInput) -> String {
    let mut object = core_attributes(input);

    object.push((
        "TypeAssignments".to_owned(),
        JsonValue::Array(sorted_type_assignments(input)),
    ));
    object.push((
        "PropertySets".to_owned(),
        JsonValue::Array(sorted_property_sets(input).into_iter().map(|(_, v)| v).collect()),
    ));
    object.push((
        "QuantitySets".to_owned(),
        JsonValue::Array(sorted_quantity_sets(input).into_iter().map(|(_, v)| v).collect()),
    ));

    let materials = sorted_string_list(&input.materials);
    if !materials.is_empty() {
        object.push(("Materials".to_owned(), string_array(&materials)));
    }
    let classifications = sorted_string_list(&input.classifications);
    if !classifications.is_empty() {
        object.push(("Classifications".to_owned(), string_array(&classifications)));
    }

    stable_hash(&stringify(&JsonValue::Object(object)))
}

/// Per-component sub-hashes, making the conflict unit `(entity, componentKey)`.
///
/// Keys match the layer op vocabulary so diff keys and op keys share one
/// spelling: `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`,
/// `material`, `classification`.
///
/// Only components the entity actually carries get a key, so adding or
/// removing one is visible as key presence rather than as an "empty" hash.
///
/// Every sub-hash is computed over the same projection
/// [`build_data_fingerprint`] hashes, the `GlobalId`-free type assignment
/// included. That is a requirement: the content pass uses these as a collision
/// guard, retiring an added/deleted pair only once they agree, on the grounds
/// that a component hashes a slice of what the whole hash covers. Projecting
/// differently here would turn that guard into a re-export filter, vetoing the
/// very matches the engine exists to find.
pub fn build_component_fingerprints(input: &DataFingerprintInput) -> BTreeMap<String, String> {
    let mut components = BTreeMap::new();

    components.insert(
        "attr:core".to_owned(),
        stable_hash(&stringify(&JsonValue::Object(core_attributes(input)))),
    );

    for (name, set) in sorted_property_sets(input) {
        let members = member_array(&set, "properties");
        components.insert(format!("pset:{name}"), stable_hash(&stringify(&members)));
    }
    for (name, set) in sorted_quantity_sets(input) {
        let members = member_array(&set, "quantities");
        components.insert(format!("qset:{name}"), stable_hash(&stringify(&members)));
    }

    let type_assignments = sorted_type_assignments(input);
    if !type_assignments.is_empty() {
        components.insert(
            "type-assignment".to_owned(),
            stable_hash(&stringify(&JsonValue::Array(type_assignments))),
        );
    }

    let materials = sorted_string_list(&input.materials);
    if !materials.is_empty() {
        components.insert(
            "material".to_owned(),
            stable_hash(&stringify(&string_array(&materials))),
        );
    }
    let classifications = sorted_string_list(&input.classifications);
    if !classifications.is_empty() {
        components.insert(
            "classification".to_owned(),
            stable_hash(&stringify(&string_array(&classifications))),
        );
    }

    components
}

/// Pull a set's member array back out of its canonical object form.
///
/// The component hash covers only the members, not the wrapping `name`, which
/// is already carried by the component key itself.
fn member_array(set: &JsonValue, members_key: &str) -> JsonValue {
    if let JsonValue::Object(entries) = set {
        for (key, value) in entries {
            if key == members_key {
                return value.clone();
            }
        }
    }
    JsonValue::Array(Vec::new())
}
