// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Runtime by-name attribute lookup over the generated EXPRESS registries.
//!
//! The generator (`@ifc-lite/codegen`) emits, beside every
//! `IfcType::attribute_names()`, a parallel `attribute_flags()` byte slice:
//! bits 0-3 the value kind, bit 4 AGGREGATE, bit 5 OPTIONAL. This module is
//! the one decoder of those bytes and the one by-name lookup over them
//! ([`SchemaVersion::attribute`]); callers that need "where does attribute X
//! of entity Y live, and what shape is it" ask here instead of keeping a
//! second table (F3e-0a, #7780).
//!
//! The lookup is ASCII-case-insensitive in both the entity and the attribute
//! name, per-schema (a position in IFC4 says nothing about IFC2X3), and
//! answers `None` explicitly for an entity the schema does not declare or an
//! attribute the entity does not have. It scans the entity's attribute list
//! (a few dozen names at most) after one registry match; callers on a loop
//! memoise the result per entity type.

use crate::generated::schema_registry::SchemaVersion;

/// What an attribute's declared EXPRESS type resolves to, through defined
/// types and selects. Mirrors `KIND` in `packages/codegen/src/rust-attribute-flags.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
#[repr(u8)]
pub enum AttrKind {
    /// An entity, or a select of entities only.
    Ref = 0,
    /// An aggregate of entities.
    RefList = 1,
    /// Any other aggregate.
    List = 2,
    /// REAL or NUMBER.
    Real = 3,
    /// INTEGER.
    Int = 4,
    /// STRING.
    Text = 5,
    /// An ENUMERATION.
    Enum = 6,
    /// BOOLEAN or LOGICAL.
    Logical = 7,
    /// BINARY.
    Binary = 8,
    /// A select mixing entities with value types.
    Select = 9,
}

const KIND_MASK: u8 = 0x0F;
const AGGREGATE: u8 = 0x10;
const OPTIONAL: u8 = 0x20;

impl AttrKind {
    pub(crate) fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            0 => Self::Ref,
            1 => Self::RefList,
            2 => Self::List,
            3 => Self::Real,
            4 => Self::Int,
            5 => Self::Text,
            6 => Self::Enum,
            7 => Self::Logical,
            8 => Self::Binary,
            9 => Self::Select,
            _ => return None,
        })
    }
}

/// One declared attribute of an entity in one schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct AttrSlot {
    /// Position in the STEP record (supertype attributes first), as
    /// `DecodedEntity::get` indexes it.
    pub index: usize,
    /// The resolved value kind.
    pub kind: AttrKind,
    /// The value may be written as a STEP list: a LIST/SET/ARRAY, a defined
    /// type that is one, or a select with such an alternative (for example
    /// `IfcRelDefinesByProperties.RelatingPropertyDefinition`).
    pub aggregate: bool,
    /// The EXPRESS declaration says OPTIONAL.
    pub optional: bool,
}

fn decode(index: usize, flags: u8) -> AttrSlot {
    AttrSlot {
        index,
        // The generator only emits codes 0..=9 (asserted for every entity of
        // every schema in the tests); Select is the conservative reading of
        // a code from a newer generator.
        kind: AttrKind::from_code(flags & KIND_MASK).unwrap_or(AttrKind::Select),
        aggregate: flags & AGGREGATE != 0,
        optional: flags & OPTIONAL != 0,
    }
}

impl SchemaVersion {
    /// The attribute `name` of `entity` in this schema, or `None` when the
    /// schema does not declare the entity or the entity has no such attribute.
    ///
    /// Both names compare ASCII-case-insensitively (`IfcWall`, `IFCWALL`,
    /// `globalid`). A name with non-ASCII characters never matches.
    pub fn attribute(self, entity: &str, name: &str) -> Option<AttrSlot> {
        let (names, flags) = self.attribute_layout(entity)?;
        let index = names.iter().position(|n| n.eq_ignore_ascii_case(name))?;
        Some(decode(index, flags[index]))
    }

    /// Every attribute of `entity` in declaration order, or `None` when the
    /// schema does not declare the entity. A declared entity without
    /// attributes yields an empty iterator.
    pub fn attributes(self, entity: &str) -> Option<impl ExactSizeIterator<Item = AttrSlot>> {
        let (_, flags) = self.attribute_layout(entity)?;
        Some(
            flags
                .iter()
                .enumerate()
                .map(|(index, flags)| decode(index, *flags)),
        )
    }

}

#[cfg(test)]
#[path = "attribute_slot_tests.rs"]
mod tests;
