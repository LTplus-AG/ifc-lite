// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3e-0a (#7780): core's `SchemaVersion::attribute` reproduces the two
//! generated server tables row for row, so C6-4 can delete the tables and
//! their generators and resolve the same positions from the core registry.
//!
//! `attr_indices.rs` is the IFC4 (`IFC4_ADD2_TC1`) layout of the six root
//! attributes; `relationship_slots.rs` is the relating/related plan, the first
//! schema of IFC4X3, IFC4, IFC2X3 that yields one. Both are replayed here
//! through the lookup alone.

use super::{relationship_slots, root_attr_indices};
use ifc_lite_core::{AttrKind, AttrSlot, SchemaVersion, IFC_TYPES};

/// The UPPERCASE keys of a generated `match` table, read off its source: the
/// tables expose lookups, not their key sets.
fn table_keys(source: &str) -> Vec<&str> {
    source
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\" => Some("))
        .map(|(key, _)| key)
        .collect()
}

#[test]
fn attr_indices_table_is_the_ifc4_lookup() {
    let keys = table_keys(include_str!("attr_indices.rs"));
    assert_eq!(keys.len(), 776, "the table covers IFC4_ADD2_TC1");

    // Every entity of the canonical universe that IFC4 declares is a row. (The
    // table also holds IFC4 entities IFC4X3 dropped, such as IfcDoorStyle;
    // those rows are checked by the loop below, and the 776 above is the
    // entity count of IFC4_ADD2_TC1.exp.)
    for t in IFC_TYPES {
        if SchemaVersion::Ifc4.attribute_names(t.as_str()).is_some() {
            assert!(keys.contains(&t.as_str()), "{} has no row", t.as_str());
        }
    }

    for key in keys {
        let row = root_attr_indices(key).expect(key);
        let at = |name: &str| {
            SchemaVersion::Ifc4
                .attribute(key, name)
                .map_or(-1, |slot| slot.index as i8)
        };
        assert_eq!(
            (
                row.global_id,
                row.name,
                row.description,
                row.object_type,
                row.tag,
                row.predefined_type
            ),
            (
                at("GlobalId"),
                at("Name"),
                at("Description"),
                at("ObjectType"),
                at("Tag"),
                at("PredefinedType")
            ),
            "{key}"
        );
    }
}

/// A reference-bearing slot, as `relationship-schema-slots.ts` reads it: an
/// entity, an aggregate of entities, or a select (never a value type).
fn is_reference(slot: &AttrSlot) -> bool {
    matches!(slot.kind, AttrKind::Ref | AttrKind::RefList | AttrKind::Select)
}

/// `computeSlotPlan` of `relationship-schema-slots.ts`, over core's lookup.
fn plan(schema: SchemaVersion, entity: &str) -> Option<[AttrSlot; 2]> {
    const ROOT_ATTR_COUNT: usize = 4;
    let names = schema.attribute_names(entity)?;
    if names.len() <= ROOT_ATTR_COUNT {
        return None;
    }
    let (mut relating, mut related) = (vec![], vec![]);
    for slot in schema.attributes(entity)?.skip(ROOT_ATTR_COUNT) {
        if !is_reference(&slot) {
            continue;
        }
        if names[slot.index].starts_with("Relating") {
            relating.push(slot);
        } else if names[slot.index].starts_with("Related") {
            related.push(slot);
        }
    }
    // IFC2X3 IfcRelCoversSpaces: two Related* endpoints, no Relating*.
    if relating.is_empty() && related.len() >= 2 {
        return Some([related[0], related[1]]);
    }
    Some([*relating.first()?, *related.first()?])
}

#[test]
fn relationship_slots_table_is_the_core_plan() {
    let keys = table_keys(include_str!("relationship_slots.rs"));
    assert_eq!(keys.len(), 54);
    for key in keys {
        let row = relationship_slots(key).expect(key);
        let [relating, related] = [SchemaVersion::Ifc4x3, SchemaVersion::Ifc4, SchemaVersion::Ifc2x3]
            .into_iter()
            .find_map(|schema| plan(schema, key))
            .unwrap_or_else(|| panic!("{key}: no schema yields a plan"));
        assert_eq!(
            (
                row.relating_idx as usize,
                row.related_idx as usize,
                row.relating_is_list,
                row.related_is_list
            ),
            (relating.index, related.index, relating.aggregate, related.aggregate),
            "{key}"
        );
    }
}
