// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_core::attribute_names_for_schema;

fn fixture() -> Vec<(String, Vec<(String, String)>)> {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_positional_renames.json")).expect("valid JSON");
    doc["renames"]
        .as_array()
        .expect("renames")
        .iter()
        .map(|r| {
            let pairs = r["pairs"]
                .as_array()
                .expect("pairs")
                .iter()
                .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
                .collect();
            (r["type"].as_str().unwrap().to_string(), pairs)
        })
        .collect()
}

/// The table is the shared fixture, entry for entry (the TypeScript twin runs
/// the same comparison).
#[test]
fn the_table_is_the_shared_fixture_7739() {
    let table: Vec<(String, Vec<(String, String)>)> = POSITIONAL_RENAMES
        .iter()
        .map(|(ty, pairs)| (ty.to_string(), pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()))
        .collect();
    assert!(table.len() >= 10, "anti-vacuity");
    assert_eq!(table, fixture());
}

/// Every allowance is a rename of the registry: the older name at some index of
/// one schema and the newer name at the same index of another, and the two
/// lists then differ at no other index within their common length.
#[test]
fn every_rename_is_a_same_index_rename_in_core_7739() {
    let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
    for (ty, pairs) in POSITIONAL_RENAMES {
        for (older, newer) in *pairs {
            let found = schemas.iter().any(|a| {
                schemas.iter().any(|b| {
                    let (Some(x), Some(y)) = (attribute_names_for_schema(a, ty), attribute_names_for_schema(b, ty))
                    else {
                        return false;
                    };
                    x.iter().zip(y).any(|(p, q)| p == older && q == newer)
                })
            });
            assert!(found, "{ty}: {older} -> {newer} is not a same-index rename in core's registry");
        }
    }
}

/// Without the table the lists are not prefixes; with it they are, in the one
/// direction a pad or trim needs, and a non-listed type is untouched.
#[test]
fn a_renamed_list_is_a_prefix_only_for_a_listed_type_7739() {
    let old = attribute_names_for_schema("IFC2X3", "IFCSTAIRFLIGHT").unwrap();
    let new = attribute_names_for_schema("IFC4", "IFCSTAIRFLIGHT").unwrap();
    assert!(is_strict_attr_prefix("IFCSTAIRFLIGHT", old, new));
    assert!(!is_strict_attr_prefix("IFCSTAIRFLIGHT", new, old));
    assert!(!is_strict_attr_prefix("IFCSTAIR", old, new), "an unlisted type name does not rename");
    assert!(!old.starts_with(&new[..old.len()]), "by name alone it is not a prefix");
}

/// #10758: the replacement table is the shared fixture's `replaced` block,
/// and each pair sits at one index of core's registry, with every other index
/// of the common length matching once renames are read as one name.
#[test]
fn every_replacement_is_the_shared_fixture_and_a_same_index_pair_10758() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_positional_renames.json")).expect("valid JSON");
    let fixture: Vec<(String, String, String)> = doc["replaced"]
        .as_array()
        .expect("replaced")
        .iter()
        .map(|r| (r["type"].as_str().unwrap().into(), r["pair"][0].as_str().unwrap().into(), r["pair"][1].as_str().unwrap().into()))
        .collect();
    let table: Vec<(String, String, String)> =
        POSITIONAL_REPLACEMENTS.iter().map(|(ty, (a, b))| (ty.to_string(), a.to_string(), b.to_string())).collect();
    assert!(!table.is_empty(), "anti-vacuity");
    assert_eq!(table, fixture);
    for (ty, _) in POSITIONAL_REPLACEMENTS {
        let old = attribute_names_for_schema("IFC2X3", ty).unwrap();
        let new = attribute_names_for_schema("IFC4", ty).unwrap();
        assert!(is_strict_attr_prefix(ty, old, new), "{ty}: IFC2X3 is a prefix of IFC4 once read as one name");
        let slot = replaced_slot(ty, old, new).expect("the pair sits at one index");
        assert_eq!(replaced_slot(ty, new, old), Some(slot), "either direction");
        assert_eq!(replaced_slot("IFCISHAPEPROFILEDEF", old, new), None, "an unlisted type replaces nothing");
    }
}

/// #10758: the converter writes `$` into a replaced slot, which is only valid
/// where neither schema requires it.
#[test]
fn a_replaced_slot_is_optional_in_both_schemas_10758() {
    use crate::generated::ifc2x3_required_slots::IFC2X3_REQUIRED_SLOTS;
    use crate::generated::ifc4_required_slots::IFC4_REQUIRED_SLOTS;
    for (ty, _) in POSITIONAL_REPLACEMENTS {
        let old = attribute_names_for_schema("IFC2X3", ty).unwrap();
        let slot = replaced_slot(ty, old, attribute_names_for_schema("IFC4", ty).unwrap()).unwrap();
        let ifc2x3 = IFC2X3_REQUIRED_SLOTS.iter().find(|r| r.0 == *ty).expect("IFC2X3 row");
        let ifc4 = IFC4_REQUIRED_SLOTS.iter().find(|r| r.0 == *ty).expect("IFC4 row");
        assert!(ifc2x3.2.iter().all(|r| usize::from(r.0) != slot), "{ty}: slot {slot} is required in IFC2X3");
        assert!(ifc4.2.iter().all(|r| usize::from(r.0) != slot), "{ty}: slot {slot} is required in IFC4");
    }
}
