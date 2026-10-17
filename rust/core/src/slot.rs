// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Typed attribute slots: the named, kind-checked replacement for a literal
//! attribute index (F3e-0b, #7780).
//!
//! ```
//! use ifc_lite_core::{slot, EntityDecoder};
//!
//! let content = "#1=IFCPROJECT('guid',$,'P',$,$,$,$,$,#9);";
//! let mut decoder = EntityDecoder::new(content);
//! let project = decoder.decode_by_id(1).unwrap();
//! assert_eq!(project.string_at(slot::IfcProject::NAME), Some("P"));
//! assert_eq!(project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT), Some(9));
//! ```
//!
//! There is one zero-sized struct per entity ([`IfcProject`] and the other
//! 1,000 in [`crate::generated::slots`]), with the supertype's attributes
//! flattened in, so `slot::IfcWall::OBJECT_PLACEMENT` exists. Each const names
//! one attribute and carries the kind of value it holds ([`kind`]).
//!
//! * [`Slot`] has the same position in every bundled schema that declares the
//!   entity (a "trailing" slot is one past the end of the older schemas'
//!   records, which reads as `None` either way). It converts to its index at
//!   compile time, so a read is the same instruction as the literal it
//!   replaces.
//! * [`SchemaSlot`] moves between schemas (or names something else). It has
//!   no `index()`: it can only be read after it is resolved against a
//!   [`SchemaVersion`], by [`SchemaSlot::at`] with an explicit pin or by
//!   [`crate::EntityDecoder::slot`] with the source's own schema. Resolve it
//!   once, outside any per-entity loop.
//!
//! The typed accessors on [`DecodedEntity`] take `impl Into<SlotIx<K>>`: a
//! `Slot<K>` of the matching kind (a `Slot<Select>` fits any kind), or a
//! computed `usize` for generic walkers. The old `get_*(usize)` readers stay.
//! The generated positions are checked against the registries by tests, and in
//! debug builds every typed accessor asserts that the entity is the slot's
//! owner or one of its subtypes.

use crate::generated::{IfcType, SchemaVersion};
use crate::schema_gen::{AttributeValue, DecodedEntity};
use std::fmt;
use std::marker::PhantomData;

pub use crate::generated::slots::*;

/// Value kinds a [`Slot`] can carry. Mirrors [`crate::AttrKind`].
pub mod kind {
    macro_rules! kinds {
        ($($(#[$doc:meta])* $name:ident),* $(,)?) => {
            $($(#[$doc])* #[derive(Debug, Clone, Copy)] pub struct $name;)*
        };
    }
    kinds! {
        /// An entity reference (or a select of entities only).
        Ref,
        /// A list of entity references.
        RefList,
        /// Any other aggregate.
        List,
        /// REAL or NUMBER.
        Real,
        /// INTEGER.
        Int,
        /// STRING.
        Text,
        /// An ENUMERATION.
        Enum,
        /// BOOLEAN or LOGICAL.
        Logical,
        /// BINARY.
        Binary,
        /// A select mixing entities with value types, or an attribute whose
        /// kind differs between schemas. Fits every typed accessor.
        Select,
    }
}

use kind::{Binary, Enum, Int, List, Logical, Real, Ref, RefList, Select, Text};

/// `by_schema` entry for a schema that does not declare the entity or the
/// attribute.
pub const ABSENT: u8 = u8::MAX;

/// A named attribute position that is the same in every bundled schema.
pub struct Slot<K> {
    index: u8,
    #[cfg(debug_assertions)]
    owner: u32,
    _kind: PhantomData<fn() -> K>,
}

impl<K> Slot<K> {
    /// Used by the generated slot tables: the STEP record position and the
    /// CRC32 id of the entity the slot belongs to.
    #[doc(hidden)]
    pub const fn new(index: u8, owner: u32) -> Self {
        #[cfg(not(debug_assertions))]
        let _ = owner;
        Self {
            index,
            #[cfg(debug_assertions)]
            owner,
            _kind: PhantomData,
        }
    }

    /// The position in the STEP record, as `DecodedEntity::get` indexes it.
    pub const fn index(self) -> usize {
        self.index as usize
    }
}

/// A named attribute position that moves between schemas. Resolve it with
/// [`SchemaSlot::at`] (an explicit pin) or [`crate::EntityDecoder::slot`]
/// (the source's own schema); there is deliberately no `index()`.
pub struct SchemaSlot<K> {
    by_schema: [u8; 5],
    owner: u32,
    _kind: PhantomData<fn() -> K>,
}

impl<K> SchemaSlot<K> {
    /// Used by the generated slot tables: the position per schema in
    /// [`SchemaVersion`] declaration order ([`ABSENT`] when the schema has no
    /// such attribute) and the CRC32 id of the owning entity.
    #[doc(hidden)]
    pub const fn new(by_schema: [u8; 5], owner: u32) -> Self {
        Self {
            by_schema,
            owner,
            _kind: PhantomData,
        }
    }

    /// The slot as `schema` lays it out, or `None` when that schema has no
    /// such attribute (for example `IfcSpace.InteriorOrExteriorSpace` after
    /// IFC2X3). Pin a schema explicitly only where the entity exists in
    /// that family alone, and say why in a comment.
    pub const fn at(self, schema: SchemaVersion) -> Option<Slot<K>> {
        let index = self.by_schema[schema_ordinal(schema)];
        if index == ABSENT {
            None
        } else {
            Some(Slot::new(index, self.owner))
        }
    }
}

/// `by_schema` position of `schema`: [`SchemaVersion`] declaration order.
const fn schema_ordinal(schema: SchemaVersion) -> usize {
    match schema {
        SchemaVersion::Ifc2x3 => 0,
        SchemaVersion::Ifc4 => 1,
        SchemaVersion::Ifc4x1 => 2,
        SchemaVersion::Ifc4x2 => 3,
        // A newer schema (the enum is non-exhaustive) reads as the newest
        // bundled layout, like an undeclared FILE_SCHEMA does.
        _ => 4,
    }
}

/// A position the typed accessors read: a [`Slot`] of kind `K` (or
/// [`Select`]), or a computed `usize`.
pub struct SlotIx<K> {
    index: usize,
    #[cfg(debug_assertions)]
    owner: u32,
    _kind: PhantomData<fn() -> K>,
}

impl<K> SlotIx<K> {
    #[inline(always)]
    fn of_slot<S>(slot: Slot<S>) -> Self {
        Self {
            index: slot.index(),
            #[cfg(debug_assertions)]
            owner: slot.owner,
            _kind: PhantomData,
        }
    }

    /// Resolve against `entity`; debug builds check the slot's owner.
    #[inline(always)]
    fn at(self, entity: &DecodedEntity) -> usize {
        #[cfg(debug_assertions)]
        assert_owner(entity, self.owner, self.index);
        #[cfg(not(debug_assertions))]
        let _ = entity;
        self.index
    }
}

impl<K> From<usize> for SlotIx<K> {
    #[inline(always)]
    fn from(index: usize) -> Self {
        Self {
            index,
            #[cfg(debug_assertions)]
            owner: 0,
            _kind: PhantomData,
        }
    }
}

macro_rules! slot_kinds {
    ($($k:ident),* $(,)?) => {$(
        impl From<Slot<$k>> for SlotIx<$k> {
            #[inline(always)]
            fn from(slot: Slot<$k>) -> Self { Self::of_slot(slot) }
        }
        impl From<Slot<Select>> for SlotIx<$k> {
            #[inline(always)]
            fn from(slot: Slot<Select>) -> Self { Self::of_slot(slot) }
        }
    )*};
}
slot_kinds!(Ref, RefList, List, Real, Int, Text, Enum, Logical, Binary);

impl From<Slot<Select>> for SlotIx<Select> {
    #[inline(always)]
    fn from(slot: Slot<Select>) -> Self {
        Self::of_slot(slot)
    }
}

/// Any position [`DecodedEntity::attr`] reads, whatever its kind: a
/// [`Slot`] of any kind, or a computed `usize`.
pub trait AnySlot {
    /// This position without its kind.
    fn into_any(self) -> SlotIx<Select>;
}

impl AnySlot for usize {
    #[inline(always)]
    fn into_any(self) -> SlotIx<Select> {
        self.into()
    }
}

impl<K> AnySlot for Slot<K> {
    #[inline(always)]
    fn into_any(self) -> SlotIx<Select> {
        SlotIx::of_slot(self)
    }
}

impl<K> Clone for Slot<K> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<K> Copy for Slot<K> {}

impl<K> fmt::Debug for Slot<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Slot({})", self.index)
    }
}

impl<K> PartialEq for Slot<K> {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index
    }
}
impl<K> Eq for Slot<K> {}

impl<K> Clone for SchemaSlot<K> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<K> Copy for SchemaSlot<K> {}

impl<K> fmt::Debug for SchemaSlot<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SchemaSlot({:?})", self.by_schema)
    }
}

/// Debug builds only: the entity must be the slot's owner or a subtype of it,
/// in at least one bundled schema's hierarchy. The whole test suite therefore
/// checks that each migrated slot belongs to the record it reads.
#[cfg(debug_assertions)]
fn assert_owner(entity: &DecodedEntity, owner: u32, index: usize) {
    let Some(owner_type) = IfcType::from_id(owner) else {
        return;
    };
    // An unknown keyword has no hierarchy to check.
    if matches!(entity.ifc_type, IfcType::Unknown(_)) || entity.ifc_type == owner_type {
        return;
    }
    let (child, parent) = (entity.ifc_type.as_str(), owner_type.as_str());
    const ALL: [SchemaVersion; 5] = [
        SchemaVersion::Ifc2x3,
        SchemaVersion::Ifc4,
        SchemaVersion::Ifc4x1,
        SchemaVersion::Ifc4x2,
        SchemaVersion::Ifc4x3,
    ];
    assert!(
        ALL.iter().any(|schema| schema.is_subtype_of(child, parent)),
        "slot {index} belongs to {parent} but was read from #{} {child}",
        entity.id
    );
}

impl DecodedEntity {
    /// The raw value at a slot or computed position.
    #[inline]
    pub fn attr(&self, slot: impl AnySlot) -> Option<&AttributeValue> {
        self.get(slot.into_any().at(self))
    }

    /// An entity reference (`$` and wrong shapes read as `None`).
    #[inline]
    pub fn ref_at(&self, slot: impl Into<SlotIx<Ref>>) -> Option<u32> {
        self.get(slot.into().at(self)).and_then(AttributeValue::as_entity_ref)
    }

    /// Reference members of a list, with [`DecodedEntity::get_refs`]
    /// semantics: a bare reference is a one-element list, an
    /// `IfcPropertySetDefinitionSet` typed parameter is its set, non-reference
    /// members are skipped, and an empty result is `None`.
    #[inline]
    pub fn ref_list_at(&self, slot: impl Into<SlotIx<RefList>>) -> Option<Vec<u32>> {
        self.get_refs(slot.into().at(self))
    }

    /// A REAL (an INTEGER widens, a typed wrapper such as
    /// `IFCLENGTHMEASURE(2.)` is seen through), as [`AttributeValue::as_float`].
    #[inline]
    pub fn real_at(&self, slot: impl Into<SlotIx<Real>>) -> Option<f64> {
        self.get_float(slot.into().at(self))
    }

    /// An INTEGER, as [`AttributeValue::as_int`].
    #[inline]
    pub fn int_at(&self, slot: impl Into<SlotIx<Int>>) -> Option<i64> {
        self.get(slot.into().at(self)).and_then(AttributeValue::as_int)
    }

    /// A STRING, undecoded.
    #[inline]
    pub fn string_at(&self, slot: impl Into<SlotIx<Text>>) -> Option<&str> {
        self.get_string(slot.into().at(self))
    }

    /// An enumeration literal without its dots (`.ELEMENT.` reads `ELEMENT`).
    #[inline]
    pub fn enum_at(&self, slot: impl Into<SlotIx<Enum>>) -> Option<&str> {
        self.get(slot.into().at(self)).and_then(AttributeValue::as_enum)
    }

    /// A BOOLEAN or LOGICAL: `.T.` is `true`, `.F.` is `false`, `.U.`
    /// (unknown), `$` and anything else are `None`.
    #[inline]
    pub fn logical_at(&self, slot: impl Into<SlotIx<Logical>>) -> Option<bool> {
        match self.get(slot.into().at(self)).and_then(AttributeValue::as_enum)? {
            "T" => Some(true),
            "F" => Some(false),
            _ => None,
        }
    }

    /// A BINARY literal's raw content, undecoded (see
    /// [`crate::decode_step_binary`]).
    #[inline]
    pub fn binary_at(&self, slot: impl Into<SlotIx<Binary>>) -> Option<&str> {
        self.get(slot.into().at(self)).and_then(AttributeValue::as_binary_hex)
    }

    /// An aggregate's members.
    #[inline]
    pub fn list_at(&self, slot: impl Into<SlotIx<List>>) -> Option<&[AttributeValue]> {
        self.get_list(slot.into().at(self))
    }
}

#[cfg(test)]
#[path = "slot_tests.rs"]
pub(crate) mod tests;
