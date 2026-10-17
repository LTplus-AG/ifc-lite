// SPDX-License-Identifier: MPL-2.0
//! C6-4: the slots resolved from core's registry equal the rows of the two
//! generated tables they replaced (776 root-attribute rows, 54 relationship
//! rows; compared row for row before those were deleted). The relationship
//! rows survive as `tests/golden/relationship-slots.json`, which the TS
//! parser's `getRelationshipSlotPlan` is also asserted against.

use super::{plan, RelSlots, RootSlots, REL_SCHEMAS};
use ifc_lite_core::{SchemaVersion, IFC_TYPES};
use serde_json::Value;
use std::collections::BTreeSet;

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../../apps/server/tests/golden/relationship-slots.json")).unwrap()
}

fn row(v: &Value) -> RelSlots {
    let n = |k: &str| v[k].as_u64().unwrap() as usize;
    RelSlots {
        relating: n("relating"),
        related: n("related"),
        relating_is_list: v["relatingIsList"].as_bool().unwrap(),
        related_is_list: v["relatedIsList"].as_bool().unwrap(),
    }
}

#[test]
fn relationship_slots_equal_the_committed_vector_row_for_row() {
    let doc = vector();
    let slots = doc["slots"].as_object().unwrap();
    assert_eq!(slots.len(), 54);
    for (name, want) in slots {
        assert_eq!(RelSlots::for_type(name), Some(row(want)), "{name}");
        assert_eq!(RelSlots::for_type(&name.to_ascii_lowercase()), Some(row(want)), "{name} lower");
    }
}

#[test]
fn the_lookup_is_its_own_gate_over_the_whole_relationship_universe() {
    let doc = vector();
    let rows: BTreeSet<&str> = doc["slots"].as_object().unwrap().keys().map(String::as_str).collect();
    // Every IfcRel* the canonical (IFC4X3) universe names, plus the vector's own
    // names (some exist only in IFC4 or IFC2X3).
    let names: BTreeSet<&str> = IFC_TYPES
        .iter()
        .filter_map(|t| t.known_as_str())
        .filter(|n| n.starts_with("IFCREL"))
        .chain(rows.iter().copied())
        .collect();
    for name in names {
        assert_eq!(RelSlots::for_type(name).is_some(), rows.contains(name), "{name}");
    }
    // Abstract in IFC4, no Relating* in IFC2X3: resolves nowhere (no STEP file
    // instantiates it directly). Abstract supertypes are not relationships.
    for name in ["IFCRELASSOCIATES", "IFCRELCONNECTS", "IFCRELDECOMPOSES", "IFCWALL", "NOPE"] {
        assert_eq!(RelSlots::for_type(name), None, "{name}");
    }
}

/// A class declared by several schemas has one layout in all of them, with
/// one exception that is harmless: in IFC2X3 `RelatingPropertyDefinition` is a
/// plain entity reference, while IFC4 widened it to a select that includes an
/// inline set. Reading it as a list accepts both (`get_refs`).
#[test]
fn every_schema_that_declares_a_relationship_agrees_with_its_row() {
    for (name, want) in vector()["slots"].as_object().unwrap() {
        let want = row(want);
        for schema in REL_SCHEMAS {
            let Some(got) = plan(schema, name) else { continue };
            if name == "IFCRELDEFINESBYPROPERTIES" && schema == SchemaVersion::Ifc2x3 {
                assert!(!got.relating_is_list && want.relating_is_list);
                assert_eq!((got.relating, got.related), (want.relating, want.related));
            } else {
                assert_eq!(got, want, "{name} in {schema:?}");
            }
        }
    }
}

#[test]
fn root_slots_are_the_ifc4_positions() {
    let wall = RootSlots::for_type("IfcWall").unwrap();
    assert_eq!(
        (wall.global_id, wall.name, wall.description, wall.object_type, wall.tag, wall.predefined_type),
        (Some(0), Some(2), Some(3), Some(4), Some(7), Some(8)),
    );
    // Known but not rooted: IfcClassification has no GlobalId and Name at 3 (#3949).
    let classification = RootSlots::for_type("IFCCLASSIFICATION").unwrap();
    assert_eq!((classification.global_id, classification.name), (None, Some(3)));
    assert!(RootSlots::declares_global_id("ifcwall"));
    assert!(!RootSlots::declares_global_id("IFCCLASSIFICATION"));
    // Unknown to IFC4: no row, the caller applies the fallback.
    assert_eq!(RootSlots::for_type("IFCALIGNMENT"), None);
    assert!(!RootSlots::declares_global_id("IFCALIGNMENT"));
    assert_eq!(RootSlots::UNKNOWN_TYPE_FALLBACK.tag, Some(7));
}

/// D43: IFC4 positions apply to every file, whatever its schema. An IFC4X3
/// entity IFC4 does not declare falls back; one both declare is read at the
/// IFC4 position even if IFC4X3 moved it.
#[test]
fn every_ifc4_entity_has_a_row_and_the_universe_is_complete() {
    let declared = IFC_TYPES
        .iter()
        .filter_map(|t| t.known_as_str())
        .filter(|n| SchemaVersion::Ifc4.attribute_names(n).is_some())
        .count();
    assert!(declared > 700, "{declared}");
    for name in IFC_TYPES.iter().filter_map(|t| t.known_as_str()) {
        let in_ifc4 = SchemaVersion::Ifc4.attribute_names(name).is_some();
        assert_eq!(RootSlots::for_type(name).is_some(), in_ifc4, "{name}");
    }
}
