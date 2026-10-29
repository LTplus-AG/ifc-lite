// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Batch snapshots can reuse one canonical projection for both hashes (#8042).
use crate::{JsString, input::DataFingerprintInput, js_json::{JsonValue, stable_hash_json, utf16_length}};
use super::checked::{project_data, has_holes, OrderedComponents,
    check_property_sets, check_quantity_sets, check_type_assignments};

/// Equivalent to the data builder followed by the component builder, including
/// sparse string-length checks in the same order. Inputs are owned DTOs: no
/// host getter is deferred across either hash. Solo builders remain available
/// without computing an unwanted second hash.
pub fn build_fingerprint_pair_checked<E>(input: &DataFingerprintInput,
    mut check: impl FnMut(u64) -> Result<(), E>) -> Result<(String, Vec<(JsString, String)>), E> {
    check_property_sets(&input.property_sets, false, &mut check)?;
    check_quantity_sets(&input.quantity_sets, false, &mut check)?;
    let (value, core_len) = project_data(input);
    if has_holes(input) { check(utf16_length(&value, false))?; }
    let data = stable_hash_json(&value);
    let JsonValue::Object(mut fields) = value else { unreachable!("canonical data is an object") };
    // core_attributes owns the prefix; moving it avoids cloning
    // any property member tree. The remaining projections stay in this owner.
    let core = JsonValue::Object(fields.drain(..core_len).collect());
    let mut components = OrderedComponents(Vec::new());
    components.insert("attr:core".into(), stable_hash_json(&core));
    check_property_sets(&input.property_sets, true, &mut check)?;
    assert_eq!(input.property_sets.holes(), 0, "component property sets require present records");
    sets(&fields, "PropertySets", "pset:", &mut components);
    check_quantity_sets(&input.quantity_sets, true, &mut check)?;
    assert_eq!(input.quantity_sets.holes(), 0, "component quantity sets require present records");
    sets(&fields, "QuantitySets", "qset:", &mut components);
    check_type_assignments(&input.type_assignments, true, &mut check)?;
    for (field, key) in [("TypeAssignments", "type-assignment"), ("Materials", "material"), ("Classifications", "classification")] {
        if let Some((_, value @ JsonValue::Array(items))) = fields.iter().find(|(name, _)| name == field) {
            if !items.is_empty() { components.insert(key.into(), stable_hash_json(value)); }
        }
    }
    Ok((data, components.0))
}

fn sets(fields: &[(JsString, JsonValue)], field: &str, prefix: &str, components: &mut OrderedComponents) {
    let Some((_, JsonValue::Array(sets))) = fields.iter().find(|(name, _)| name == field) else {
        unreachable!("canonical data always has set collections")
    };
    for set in sets {
        let JsonValue::Object(entries) = set else { unreachable!("outer holes were rejected") };
        let JsonValue::String(name) = &entries[0].1 else { unreachable!("canonical set name") };
        components.insert(JsString::surround(prefix, name, ""), stable_hash_json(&entries[1].1));
    }
}
