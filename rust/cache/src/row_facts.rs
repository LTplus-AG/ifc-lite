// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Two per-row facts the data model does not carry in the form the Entities
//! section means them, re-read from the source records of its rows.
//!
//! - **Explicit empty `Name`** (#4930). The `name` column keeps a STEP `$`
//!   (the null index) apart from `''` (the empty string's slot), as the TS
//!   parser and `EntityTableBuilder` do. The data model folds both into
//!   `None` (`string_at` drops empty strings), so the rows it reports
//!   nameless are decoded at the slot it read: the type's IFC4 `Name`
//!   position, or index 2 for a type IFC4 does not declare (`RootSlots`,
//!   D43). A type that declares no `Name` stays absent.
//! - **Own `Representation`** (`EntityFlags.HAS_GEOMETRY`, #4666): set when
//!   the row's class has `Representation` at attribute 6 (every `IfcProduct`)
//!   and the record's own value there is not `$`. The data model's
//!   `has_geometry` is a class guess (`has_geometry_by_name`), which is a
//!   different question: an `IfcBuilding` with no body answers yes there.
//!   The record test is core's `nth_attribute_is_present`.

use std::collections::HashSet;

use ifc_lite_core::{build_entity_index, nth_attribute_is_present, AttributeValue, EntityDecoder, SchemaVersion};
use ifc_lite_processing::data_model::EntityMetadata;

/// `RootSlots::UNKNOWN_TYPE_FALLBACK`'s `Name`: the `IfcRoot` layout.
const UNKNOWN_TYPE_NAME_SLOT: usize = 2;
/// `IfcProduct.Representation`, the same index in every bundled schema.
const REPRESENTATION_SLOT: usize = 6;

/// The `Name` slot the data model reads for `type_name`, or `None` when the
/// type is known to IFC4 and declares no `Name`.
fn name_slot(type_name: &str) -> Option<usize> {
    match SchemaVersion::Ifc4.attribute_names(type_name) {
        Some(names) => names.iter().position(|name| name.eq_ignore_ascii_case("Name")),
        None => Some(UNKNOWN_TYPE_NAME_SLOT),
    }
}

/// Whether some bundled schema declares `type_name` with `Representation` at
/// attribute 6 (`getAttributeNamesAcrossSchemas(type)[6]` on the TS side).
fn has_representation_slot(type_name: &str) -> bool {
    [SchemaVersion::Ifc4x3, SchemaVersion::Ifc4, SchemaVersion::Ifc2x3].into_iter().any(|schema| {
        schema
            .attribute_names(type_name)
            .and_then(|names| names.get(REPRESENTATION_SLOT))
            .is_some_and(|name| name.eq_ignore_ascii_case("Representation"))
    })
}

#[derive(Debug, Default)]
pub(crate) struct RowFacts {
    /// Rows whose `Name` the source writes as `''`.
    pub(crate) empty_names: HashSet<u32>,
    /// Rows whose own `Representation` is set.
    pub(crate) own_representation: HashSet<u32>,
}

pub(crate) fn row_facts(source: &[u8], entities: &[EntityMetadata]) -> RowFacts {
    let mut facts = RowFacts::default();
    if entities.is_empty() {
        return facts;
    }
    let index = build_entity_index(source);
    let record = |id: u32| index.get(&id).map(|&(start, end)| &source[start..end]);
    let mut nameless = Vec::new();
    for entity in entities {
        if has_representation_slot(&entity.type_name)
            && record(entity.entity_id).is_some_and(|bytes| nth_attribute_is_present(bytes, REPRESENTATION_SLOT))
        {
            facts.own_representation.insert(entity.entity_id);
        }
        if entity.name.is_none() {
            if let Some(slot) = name_slot(&entity.type_name) {
                nameless.push((entity.entity_id, slot));
            }
        }
    }
    if nameless.is_empty() {
        return facts;
    }
    let mut decoder = EntityDecoder::with_index(source, index);
    for (id, slot) in nameless {
        let empty = decoder
            .decode_by_id(id)
            .is_ok_and(|entity| matches!(entity.get(slot), Some(AttributeValue::String(s)) if s.is_empty()));
        if empty {
            facts.empty_names.insert(id);
        }
    }
    facts
}

#[cfg(test)]
#[path = "row_facts_tests.rs"]
mod tests;
