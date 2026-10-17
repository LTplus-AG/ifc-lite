// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The property-set decoder every consumer of the data model reads through
//! (C6-7, #7783): which property kinds exist, which of them a caller asks
//! for, and the one per-model complex-property budget (#7675).
//!
//! The server's Parquet tables and the attribute export (CSV, JSON, JSON-LD,
//! IFCX, USD, BOS, Python) used to decode a property set twice, with two
//! readers that disagreed on what a set holds. Both now take a
//! [`PropertySetRow`] from here. Two encoders stay, because each is a pinned
//! contract: the server renders [`PropertyRow::display`], the columnar wire
//! the viewer decodes, and the export renders [`PropertyRow::nominal`], the
//! raw value, in its own flat form.
//!
//! There is no budget-less constructor: [`PropertyDecoder`] owns the model's
//! [`ComplexPropertyBudget`] and its per-id memo, so no caller can walk an
//! `IfcComplexProperty` without them (the k^8 fan-out #7675 closed).

use super::properties::{extract_property, resolve_complex_into, ComplexMemo};
use super::types::Property;
use ifc_lite_core::limits::ComplexPropertyBudget;
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// The seven `IfcProperty` subtypes a property set lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PropertyKind {
    Single,
    Enumerated,
    List,
    Bounded,
    Table,
    Reference,
    Complex,
}

impl PropertyKind {
    /// The kind of a property entity, `None` for any other entity.
    pub fn of(ty: &IfcType) -> Option<Self> {
        if *ty == IfcType::IfcPropertySingleValue {
            return Some(Self::Single);
        }
        Some(match ty.as_str().to_ascii_uppercase().as_str() {
            "IFCPROPERTYENUMERATEDVALUE" => Self::Enumerated,
            "IFCPROPERTYLISTVALUE" => Self::List,
            "IFCPROPERTYBOUNDEDVALUE" => Self::Bounded,
            "IFCPROPERTYTABLEVALUE" => Self::Table,
            "IFCPROPERTYREFERENCEVALUE" => Self::Reference,
            "IFCCOMPLEXPROPERTY" => Self::Complex,
            _ => return None,
        })
    }

    /// The STEP class keyword (the flat exports' `value_type` for a kind that
    /// carries no member type tag, D47).
    pub fn class_keyword(self) -> &'static str {
        match self {
            Self::Single => "IFCPROPERTYSINGLEVALUE",
            Self::Enumerated => "IFCPROPERTYENUMERATEDVALUE",
            Self::List => "IFCPROPERTYLISTVALUE",
            Self::Bounded => "IFCPROPERTYBOUNDEDVALUE",
            Self::Table => "IFCPROPERTYTABLEVALUE",
            Self::Reference => "IFCPROPERTYREFERENCEVALUE",
            Self::Complex => "IFCCOMPLEXPROPERTY",
        }
    }
}

/// Which property kinds a caller reads. A kind outside the scope is not
/// decoded at all: it costs no work and spends none of the complex budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PropertyScope {
    /// `IfcPropertySingleValue` only, with its raw nominal value and no
    /// display form.
    SingleValueOnly,
    /// Every kind, as the flat exports write it (EXPORT-DATA-2, D47): a single
    /// value carries only its raw nominal value (the flat encoder renders that
    /// and never reads a display form, so none is built), every other kind
    /// carries its display form.
    Flat,
    /// Every kind, each with its display form; a single value also carries
    /// its raw nominal value. What the server's tables read.
    AllKinds,
}

/// One decoded property.
#[derive(Debug, Clone)]
pub struct PropertyRow {
    /// The property's `Name` (attribute 0). May be empty.
    pub name: String,
    pub kind: PropertyKind,
    /// The raw `NominalValue` of an `IfcPropertySingleValue`: `None` for every
    /// other kind, and for a single value that has no such attribute.
    pub nominal: Option<AttributeValue>,
    /// The columnar display form: `Some` for every row under
    /// [`PropertyScope::AllKinds`] and for every non-single row under
    /// [`PropertyScope::Flat`]; `None` otherwise.
    pub display: Option<Property>,
}

/// One decoded `IfcPropertySet`.
#[derive(Debug, Clone)]
pub struct PropertySetRow {
    pub id: u32,
    /// The set's `Name`, `None` when it is not a string.
    pub name: Option<String>,
    pub properties: Vec<PropertyRow>,
}

/// Decodes property sets under one model's complex-property budget.
pub struct PropertyDecoder {
    scope: PropertyScope,
    budget: ComplexPropertyBudget,
    memo: ComplexMemo,
}

impl PropertyDecoder {
    /// A decoder for a model of `input_len` bytes. The budget is per model,
    /// so build one per export or extraction, not one per set.
    pub fn for_input(input_len: usize, scope: PropertyScope) -> Self {
        Self { scope, budget: ComplexPropertyBudget::for_input(input_len), memo: ComplexMemo::new() }
    }

    pub fn scope(&self) -> PropertyScope {
        self.scope
    }

    /// Complex values the budget has cut so far.
    pub fn cuts(&self) -> usize {
        self.budget.cuts()
    }

    /// Decode one `IfcPropertySet`. `None` when `HasProperties` (attribute 4)
    /// is absent or a member list does not resolve; a member that is not in
    /// scope, or does not decode, is left out and the set keeps the rest.
    ///
    /// Complex properties are charged to the budget in the order the sets
    /// are decoded, so the property a budget cuts is the same on every run
    /// for one decoding order.
    pub fn decode_set(&mut self, decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<PropertySetRow> {
        let name = def.string_at(slot::IfcPropertySet::NAME).map(str::to_string);
        let members = decoder.resolve_ref_list(def.attr(slot::IfcPropertySet::HAS_PROPERTIES)?).ok()?;
        let mut properties = Vec::new();
        for member in &members {
            let Some(kind) = PropertyKind::of(&member.ifc_type) else { continue };
            if self.scope == PropertyScope::SingleValueOnly && kind != PropertyKind::Single {
                continue;
            }
            let Some(row) = self.decode_property(decoder, member, kind) else { continue };
            properties.push(row);
        }
        Some(PropertySetRow { id: def.id, name, properties })
    }

    fn decode_property(
        &mut self, decoder: &mut EntityDecoder, entity: &DecodedEntity, kind: PropertyKind,
    ) -> Option<PropertyRow> {
        if kind == PropertyKind::Single && self.scope != PropertyScope::AllKinds {
            let name = entity.string_at(slot::IfcPropertySingleValue::NAME)?.to_string();
            return Some(PropertyRow { name, kind, nominal: entity.attr(slot::IfcPropertySingleValue::NOMINAL_VALUE).cloned(), display: None });
        }
        let mut display = extract_property(entity, decoder)?;
        if kind == PropertyKind::Complex {
            resolve_complex_into(&mut display, entity.id, decoder, &mut self.budget, &mut self.memo);
        }
        let nominal = if kind == PropertyKind::Single { entity.attr(slot::IfcPropertySingleValue::NOMINAL_VALUE).cloned() } else { None };
        Some(PropertyRow { name: display.property_name.clone(), kind, nominal, display: Some(display) })
    }
}

#[cfg(test)]
#[path = "property_tests.rs"]
mod tests;
