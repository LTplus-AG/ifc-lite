// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Fingerprint builders, with the engine string-length checks of #8114.
//!
//! The TypeScript oracle projects the input, then only computes: sorts with
//! stableSerialize tiebreaks and JSON.stringify per hash. Past projection its
//! only other outcome is the engine's RangeError for a string over the engine
//! maximum. A hole costs one `null` (or one separator) of text but no memory,
//! so the `_checked` builders give the caller each hole-bearing string's exact
//! UTF-16 length, in the oracle's order and before any O(holes) hashing. A
//! rejected length returns the caller's error. Hole-free strings are never
//! offered: they cost the input their own size, and dense input keeps the
//! materialized path unchanged. The unchecked builders accept every length.
use std::collections::BTreeMap;
use std::convert::Infallible;
use crate::JsString;
use crate::input::{DataFingerprintInput, PropertyEntryInput, PropertySetInput, QuantitySetInput, TypeAssignmentInput};
use crate::js_json::{stable_hash_json, utf16_length, JsonValue};
use crate::projections::sorted_string_list;
use crate::sparse_collection::SparseCollection;
use super::{core_attributes, set_to_json, sorted_entries, sorted_property_sets, sorted_quantity_sets,
    sorted_type_assignments, string_array, with_holes};

fn accept_all<T>(result: Result<T, Infallible>) -> T {
    match result { Ok(value) => value, Err(never) => match never {} }
}
/// Stream canonical UTF-16 directly, including hole runs (#8114, #8042).
fn hash(value: &JsonValue, _holes: bool) -> String { stable_hash_json(value) }
fn trailing_holes(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Array(items) if matches!(items.last(), Some(JsonValue::Holes(_))))
}
fn has_holes(input: &DataFingerprintInput) -> bool {
    input.property_sets.holes() > 0 || input.quantity_sets.holes() > 0 || input.type_assignments.holes() > 0
        || input.property_sets.present().any(|set| set.properties.holes() > 0)
        || input.quantity_sets.present().any(|set| set.quantities.holes() > 0)
}

/// Strings the oracle builds for one set collection: the stableSerialize
/// tiebreak of every set sharing its name with another (a sort compares each
/// adjacent pair of equal names), then, for components, each member array's
/// JSON.stringify. Only hole-bearing strings are checked: one call with the
/// longest tiebreak, then one with the longest member text.
fn check_sets<S, E>(sets: &SparseCollection<S>, part: impl Fn(&S) -> (&JsString, &SparseCollection<PropertyEntryInput>),
    key: &str, components: bool, check: &mut impl FnMut(u64) -> Result<(), E>) -> Result<(), E> {
    if !sets.present().any(|set| part(set).1.holes() > 0) { return Ok(()); }
    let mut names: Vec<&JsString> = sets.present().map(|set| part(set).0).collect();
    names.sort();
    let shared = |name: &JsString| names.partition_point(|other| *other < name) + 1 < names.partition_point(|other| *other <= name);
    let (mut tiebreak, mut members) = (None::<u64>, None::<u64>);
    for (name, entries) in sets.present().map(&part).filter(|(_, entries)| entries.holes() > 0) {
        let entries = sorted_entries(entries);
        if shared(name) {
            tiebreak = tiebreak.max(Some(utf16_length(&set_to_json(name, key, &entries), true)));
        }
        if components {
            members = members.max(Some(utf16_length(&JsonValue::Array(entries), false)));
        }
    }
    tiebreak.map_or(Ok(()), &mut *check)?;
    members.map_or(Ok(()), check)
}
/// Check the strings the oracle builds while sorting property sets and, for
/// components, while hashing each set's members (#8114). Call it once the
/// whole collection is projected, before any later input is read.
pub fn check_property_sets<E>(sets: &SparseCollection<PropertySetInput>, components: bool,
    check: &mut impl FnMut(u64) -> Result<(), E>) -> Result<(), E> {
    check_sets(sets, |set| (&set.name, &set.properties), "properties", components, check)
}
/// [`check_property_sets`] for quantity sets.
pub fn check_quantity_sets<E>(sets: &SparseCollection<QuantitySetInput>, components: bool,
    check: &mut impl FnMut(u64) -> Result<(), E>) -> Result<(), E> {
    check_sets(sets, |set| (&set.name, &set.quantities), "quantities", components, check)
}
/// The component `type-assignment` text, the only hole-bearing string a type
/// assignment projection builds before the oracle reads materials (#8114).
pub fn check_type_assignments<E>(types: &SparseCollection<TypeAssignmentInput>, components: bool,
    check: &mut impl FnMut(u64) -> Result<(), E>) -> Result<(), E> {
    if !components || types.holes() == 0 { return Ok(()); }
    check(utf16_length(&JsonValue::Array(sorted_type_assignments(types)), false))
}

/// Build the canonical data fingerprint for one entity.
///
/// Key order in the hashed object is part of the format: `Type`, `Name`,
/// `Description`, `ObjectType`, `PredefinedType`, `Tag`, `TypeAssignments`,
/// `PropertySets`, `QuantitySets`, then `Materials` and `Classifications`
/// **only when non-empty**.
pub fn build_data_fingerprint(input: &DataFingerprintInput) -> String {
    accept_all(build_data_fingerprint_checked(input, |_| Ok(())))
}

/// [`build_data_fingerprint`], offering `check` each hole-bearing string length
/// the oracle builds, in its order, before hashing (see the module docs).
pub fn build_data_fingerprint_checked<E>(input: &DataFingerprintInput,
    mut check: impl FnMut(u64) -> Result<(), E>) -> Result<String, E> {
    check_property_sets(&input.property_sets, false, &mut check)?;
    check_quantity_sets(&input.quantity_sets, false, &mut check)?;
    let mut object = core_attributes(input);

    object.push((
        "TypeAssignments".into(),
        JsonValue::Array(sorted_type_assignments(&input.type_assignments)),
    ));
    object.push((
        "PropertySets".into(),
        JsonValue::Array(with_holes(sorted_property_sets(input).into_iter().map(|(_, v)| v).collect(), input.property_sets.holes())),
    ));
    object.push((
        "QuantitySets".into(),
        JsonValue::Array(with_holes(sorted_quantity_sets(input).into_iter().map(|(_, v)| v).collect(), input.quantity_sets.holes())),
    ));

    let materials = sorted_string_list(&input.materials);
    if !materials.is_empty() {
        object.push(("Materials".into(), string_array(&materials)));
    }
    let classifications = sorted_string_list(&input.classifications);
    if !classifications.is_empty() {
        object.push(("Classifications".into(), string_array(&classifications)));
    }

    let value = JsonValue::Object(object);
    let holes = has_holes(input);
    if holes { check(utf16_length(&value, false))?; }
    Ok(hash(&value, holes))
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
pub fn build_component_fingerprints(input: &DataFingerprintInput) -> BTreeMap<JsString, String> {
    build_component_fingerprint_entries(input).into_iter().collect()
}

/// JavaScript Map insertion order, including first-position/last-value updates
/// for duplicate component keys. The WASM object boundary consumes this form.
///
/// Panics for outer property/quantity-set holes: component iteration requires
/// a set name. The public JS facade raises its original host TypeError before
/// crossing this boundary, while native callers must supply named outer sets.
pub fn build_component_fingerprint_entries(input: &DataFingerprintInput) -> Vec<(JsString, String)> {
    accept_all(build_component_fingerprint_entries_checked(input, |_| Ok(())))
}

/// [`build_component_fingerprint_entries`] with [`build_data_fingerprint_checked`]'s
/// length checks. Like the oracle, a set collection's checks precede the panic
/// for its outer holes, and each collection's precede the next collection.
pub fn build_component_fingerprint_entries_checked<E>(input: &DataFingerprintInput,
    mut check: impl FnMut(u64) -> Result<(), E>) -> Result<Vec<(JsString, String)>, E> {
    let mut components = OrderedComponents(Vec::new());

    components.insert(
        "attr:core".into(),
        stable_hash_json(&JsonValue::Object(core_attributes(input))),
    );

    check_property_sets(&input.property_sets, true, &mut check)?;
    assert_eq!(input.property_sets.holes(), 0, "component property sets require present records");
    for (name, set) in sorted_property_sets(input) {
        let members = member_array(&set, "properties");
        components.insert(JsString::surround("pset:", &name, ""), hash(&members, trailing_holes(&members)));
    }
    check_quantity_sets(&input.quantity_sets, true, &mut check)?;
    assert_eq!(input.quantity_sets.holes(), 0, "component quantity sets require present records");
    for (name, set) in sorted_quantity_sets(input) {
        let members = member_array(&set, "quantities");
        components.insert(JsString::surround("qset:", &name, ""), hash(&members, trailing_holes(&members)));
    }

    check_type_assignments(&input.type_assignments, true, &mut check)?;
    let type_assignments = sorted_type_assignments(&input.type_assignments);
    if !type_assignments.is_empty() {
        let value = JsonValue::Array(type_assignments);
        components.insert("type-assignment".into(), hash(&value, trailing_holes(&value)));
    }

    let materials = sorted_string_list(&input.materials);
    if !materials.is_empty() {
        components.insert(
            "material".into(),
            stable_hash_json(&string_array(&materials)),
        );
    }
    let classifications = sorted_string_list(&input.classifications);
    if !classifications.is_empty() {
        components.insert(
            "classification".into(),
            stable_hash_json(&string_array(&classifications)),
        );
    }

    Ok(components.0)
}

struct OrderedComponents(Vec<(JsString, String)>);
impl OrderedComponents {
    fn insert(&mut self, key: JsString, value: String) {
        if let Some((_, old)) = self.0.iter_mut().find(|(name, _)| *name == key) { *old = value; }
        else { self.0.push((key, value)); }
    }
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
