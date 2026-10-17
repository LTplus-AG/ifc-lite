// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Attribute and relationship slots, resolved from core's EXPRESS registry
//! (C6-4, D43) by `SchemaVersion::attribute` / `attributes` (F3e-0a, #7780).
//!
//! These replace two generated tables (`attr_indices.rs`, 776 rows, and
//! `relationship_slots.rs`, 54 rows) that were fed from the TypeScript schema
//! registry by two generator scripts. Core's lookup was proved equal to both,
//! row for row, before they were deleted. The relationship rows are kept as a
//! committed vector (`tests/golden/relationship-slots.json`) so the TS side
//! (`getRelationshipSlotPlan`) is pinned to the same positions.
//!
//! Root attributes (D43): every file is read at its **IFC4** positions, an
//! explicit, tested choice (SERVER-28; the TS columnar parser does the same).
//! A per-file-schema version is a separate change with its TS twin.

use ifc_lite_core::{AttrKind, AttrSlot, SchemaVersion};

/// Positions of the six root attributes of one entity type in IFC4; `None` =
/// the type is known to IFC4 and does not declare that attribute (never fall
/// back for these).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RootSlots {
    pub(super) global_id: Option<usize>,
    pub(super) name: Option<usize>,
    pub(super) description: Option<usize>,
    pub(super) object_type: Option<usize>,
    pub(super) tag: Option<usize>,
    pub(super) predefined_type: Option<usize>,
}

impl RootSlots {
    /// Unknown-type fallback, mirroring the WASM path's
    /// `extractRootAttributesFromEntity`: GlobalId 0, Name 2, Description 3,
    /// ObjectType 4, Tag 7 (the IfcElement/IfcRoot layout), and NO
    /// PredefinedType. Applied only when the type is absent from the IFC4
    /// registry (issue #3949).
    pub(super) const UNKNOWN_TYPE_FALLBACK: Self = Self {
        global_id: Some(0),
        name: Some(2),
        description: Some(3),
        object_type: Some(4),
        tag: Some(7),
        predefined_type: None,
    };

    /// The slots of `type_name` (any case), or `None` when IFC4 does not
    /// declare the type.
    pub(super) fn for_type(type_name: &str) -> Option<Self> {
        let names = SchemaVersion::Ifc4.attribute_names(type_name)?;
        let at = |wanted: &str| names.iter().position(|n| n.eq_ignore_ascii_case(wanted));
        Some(Self {
            global_id: at("GlobalId"),
            name: at("Name"),
            description: at("Description"),
            object_type: at("ObjectType"),
            tag: at("Tag"),
            predefined_type: at("PredefinedType"),
        })
    }

    /// Whether the IFC4 registry lists the type as declaring a GlobalId, i.e.
    /// as an `IfcRoot` subtype. `false` for a type the registry does not know.
    pub(super) fn declares_global_id(type_name: &str) -> bool {
        Self::for_type(type_name).is_some_and(|slots| slots.global_id.is_some())
    }
}

/// Where a concrete `IfcRelationship` subtype keeps its relating and related
/// references (absolute attribute positions).
///
/// `relating_is_list` is true for exactly one type, `IFCRELDEFINESBYPROPERTIES`
/// (`RelatingPropertyDefinition` may be an inline `IfcPropertySetDefinitionSet`
/// `(#20,#21)`); reading it with `get_ref` alone would drop the whole
/// relationship.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RelSlots {
    pub(super) relating: usize,
    pub(super) related: usize,
    pub(super) relating_is_list: bool,
    pub(super) related_is_list: bool,
}

/// Most-featured schema first: an IFC4X3-only class must resolve even though
/// IFC4 is the root-attribute schema. A class declared by several schemas has
/// the same layout in each (proved by `slots_tests`), so order only decides
/// the types a single schema declares. The order of `relationship-schema-slots.ts`.
const REL_SCHEMAS: [SchemaVersion; 3] =
    [SchemaVersion::Ifc4x3, SchemaVersion::Ifc4, SchemaVersion::Ifc2x3];

/// `IfcRoot` (GlobalId, OwnerHistory, Name, Description) is followed by the
/// relating/related attributes in every `IfcRelationship`.
const ROOT_ATTR_COUNT: usize = 4;

/// A reference-bearing slot, as `relationship-schema-slots.ts` reads it: an
/// entity, an aggregate of entities, or a select (never a value type).
fn is_reference(slot: &AttrSlot) -> bool {
    matches!(slot.kind, AttrKind::Ref | AttrKind::RefList | AttrKind::Select)
}

/// `computeSlotPlan` of `relationship-schema-slots.ts` over one schema.
fn plan(schema: SchemaVersion, entity: &str) -> Option<RelSlots> {
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
    let [relating, related] = if relating.is_empty() && related.len() >= 2 {
        [related[0], related[1]]
    } else {
        [*relating.first()?, *related.first()?]
    };
    Some(RelSlots {
        relating: relating.index,
        related: related.index,
        relating_is_list: relating.aggregate,
        related_is_list: related.aggregate,
    })
}

impl RelSlots {
    /// The slots of a STEP relationship keyword (any case), or `None` unless
    /// it is a concrete (non-abstract) `IfcRelationship` subtype in some
    /// bundled schema with a resolvable plan. The lookup is its own gate: a
    /// type is a relationship job iff it resolves here. `IFCRELASSOCIATES`
    /// (abstract in IFC4, no `Relating*` in IFC2X3) resolves nowhere, and no
    /// STEP file instantiates it directly.
    pub(super) fn for_type(type_name: &str) -> Option<Self> {
        let concrete = REL_SCHEMAS.iter().any(|schema| {
            schema
                .entity_info(type_name)
                .is_some_and(|info| !info.is_abstract && schema.is_subtype_of(type_name, "IfcRelationship"))
        });
        if !concrete {
            return None;
        }
        REL_SCHEMAS.iter().find_map(|schema| plan(*schema, type_name))
    }
}

#[cfg(test)]
#[path = "slots_tests.rs"]
mod tests;
