// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The Entities section (`sections/entities.ts`), built from the rooted
//! `DataModel` entity table.
//!
//! Layout: count u32, then one column at a time --
//!   expressId u32[], typeEnum u16[], globalId u32[], name u32[],
//!   description u32[], objectType u32[], flags u8[],
//!   containedInStorey i32[], definedByType i32[], geometryIndex i32[],
//!   typeRangeCount u16, [type u16, start u32, end u32] triples,
//!   rawTypeName u32[]  (v15+, after the triples)
//!
//! The triples are vestigial on read; they are written the way
//! `entityTableFromColumns` derives them (one per type in first-appearance
//! order, `[firstRow, lastRow + 1]`), which is also what the TS writer emits
//! for a table the TS reader produced. `containedInStorey`, `definedByType`
//! and `geometryIndex` are -1 ("not recorded"), the value the TS builders
//! initialise them to; the viewer derives containment from Relationships.

use ifc_lite_core::{ifc_type_from_keyword, IfcType};
use ifc_lite_processing::data_model::EntityMetadata;

use crate::buf::Buf;
use crate::row_facts::RowFacts;
use crate::strings::StringTable;
use crate::type_enum::type_ordinal;

/// `EntityFlags` (`packages/data/src/types.ts`).
mod flags {
    pub(super) const HAS_GEOMETRY: u8 = 1;
    pub(super) const IS_TYPE: u8 = 8;
}

struct Row {
    express_id: u32,
    type_enum: u16,
    global_id: u32,
    name: u32,
    description: u32,
    object_type: u32,
    flags: u8,
    raw_type_name: u32,
}

/// Interns each row's strings in the order `EntityTableBuilder.add` does
/// (globalId, name, description, objectType, rawTypeName) and writes the
/// section. `facts` says which nameless rows the source names `''` (every
/// other one is `$`) and which rows have their own `Representation`.
pub(crate) fn write_entities(strings: &mut StringTable, entities: &[EntityMetadata], facts: &RowFacts) -> Vec<u8> {
    let rows: Vec<Row> = entities.iter().map(|entity| row(strings, entity, facts)).collect();
    let count = rows.len();
    let mut buf = Buf::with_capacity(4 + count * 43 + 2);
    buf.u32(count as u32);
    for row in &rows {
        buf.u32(row.express_id);
    }
    for row in &rows {
        buf.u16(row.type_enum);
    }
    let string_columns: [fn(&Row) -> u32; 4] = [
        |r| r.global_id,
        |r| r.name,
        |r| r.description,
        |r| r.object_type,
    ];
    for column in string_columns {
        for row in &rows {
            buf.u32(column(row));
        }
    }
    for row in &rows {
        buf.u8(row.flags);
    }
    for _ in 0..3 {
        for _ in &rows {
            buf.i32(-1);
        }
    }
    write_type_ranges(&mut buf, &rows);
    for row in &rows {
        buf.u32(row.raw_type_name);
    }
    buf.into_vec()
}

fn row(strings: &mut StringTable, entity: &EntityMetadata, facts: &RowFacts) -> Row {
    let upper = entity.type_name.to_ascii_uppercase();
    let ty = ifc_type_from_keyword(&upper);
    let mut bits = 0;
    // The row's own Representation, not the data model's class guess (#4666).
    if facts.own_representation.contains(&entity.entity_id) {
        bits |= flags::HAS_GEOMETRY;
    }
    if ty.is_subtype_of(IfcType::IfcTypeObject) {
        bits |= flags::IS_TYPE;
    }
    Row {
        express_id: entity.entity_id,
        type_enum: type_ordinal(&upper),
        global_id: strings.intern(entity.global_id.as_deref().unwrap_or("")),
        // Absent stays absent (#4930): a `$` name is the null index, an
        // explicit `''` the empty string.
        name: strings.intern_opt(match entity.name.as_deref() {
            None if facts.empty_names.contains(&entity.entity_id) => Some(""),
            name => name,
        }),
        description: strings.intern(entity.description.as_deref().unwrap_or("")),
        object_type: strings.intern(entity.object_type.as_deref().unwrap_or("")),
        flags: bits,
        raw_type_name: strings.intern(&canonical_name(&ty, &upper)),
    }
}

/// `normalizeIfcUpperCase`: the PascalCase schema name, or the keyword as
/// given when no bundled schema declares it.
fn canonical_name(ty: &IfcType, upper: &str) -> String {
    match ty {
        IfcType::Unknown(_) => upper.to_owned(),
        known => known.name().to_owned(),
    }
}

/// One triple per distinct `typeEnum`, in first-appearance order, spanning
/// its first to last row: `entityTableFromColumns`'s derivation.
fn write_type_ranges(buf: &mut Buf, rows: &[Row]) {
    let mut spans: Vec<(u16, u32, u32)> = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        let at = at as u32;
        match spans.iter_mut().find(|(ty, _, _)| *ty == row.type_enum) {
            Some(span) => span.2 = at + 1,
            None => spans.push((row.type_enum, at, at + 1)),
        }
    }
    buf.u16(spans.len() as u16);
    for (ty, start, end) in spans {
        buf.u16(ty);
        buf.u32(start);
        buf.u32(end);
    }
}

#[cfg(test)]
#[path = "entities_tests.rs"]
mod tests;
