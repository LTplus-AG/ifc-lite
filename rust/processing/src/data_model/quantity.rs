// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Physical-quantity decoding and the one `QuantityKind` vocabulary (C6-8,
//! EXPORT-DATA-17). Moved from `rust/export/src/model_props.rs`.
//!
//! `IfcPhysicalComplexQuantity` is skipped by every consumer, on purpose.

use super::rows::{QuantitySet, QuantityValue};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// The seven simple quantity classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum QuantityKind {
    Length,
    Area,
    Volume,
    Count,
    Weight,
    Time,
    Number,
}

impl QuantityKind {
    pub const ALL: [QuantityKind; 7] = [
        Self::Length, Self::Area, Self::Volume, Self::Count, Self::Weight, Self::Time, Self::Number,
    ];

    /// The class of a quantity entity, `None` for any other type.
    pub fn of(ty: &IfcType) -> Option<Self> {
        Some(match ty {
            IfcType::IfcQuantityLength => Self::Length,
            IfcType::IfcQuantityArea => Self::Area,
            IfcType::IfcQuantityVolume => Self::Volume,
            IfcType::IfcQuantityCount => Self::Count,
            IfcType::IfcQuantityNumber => Self::Number,
            IfcType::IfcQuantityWeight => Self::Weight,
            IfcType::IfcQuantityTime => Self::Time,
            _ => return None,
        })
    }

    /// The class from a STEP keyword, ASCII-case-insensitive.
    pub fn from_keyword(keyword: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.keyword().eq_ignore_ascii_case(keyword))
    }

    /// The flat exports' kind string (`QuantityValue::kind`): `Length`, ...
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Length => "Length",
            Self::Area => "Area",
            Self::Volume => "Volume",
            Self::Count => "Count",
            Self::Weight => "Weight",
            Self::Time => "Time",
            Self::Number => "Number",
        }
    }

    /// The inverse of [`as_str`](Self::as_str).
    pub fn parse(kind: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == kind)
    }

    /// The server's lower-case `quantity_type` column: `length`, ...
    pub fn lower(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Area => "area",
            Self::Volume => "volume",
            Self::Count => "count",
            Self::Weight => "weight",
            Self::Time => "time",
            Self::Number => "number",
        }
    }

    /// The upper-case STEP keyword, `IFCQUANTITYLENGTH`.
    pub fn keyword(self) -> &'static str {
        match self {
            Self::Length => "IFCQUANTITYLENGTH",
            Self::Area => "IFCQUANTITYAREA",
            Self::Volume => "IFCQUANTITYVOLUME",
            Self::Count => "IFCQUANTITYCOUNT",
            Self::Weight => "IFCQUANTITYWEIGHT",
            Self::Time => "IFCQUANTITYTIME",
            Self::Number => "IFCQUANTITYNUMBER",
        }
    }

    /// The EXPRESS entity name, `IfcQuantityLength`.
    pub fn ifc_entity(self) -> &'static str {
        match self {
            Self::Length => "IfcQuantityLength",
            Self::Area => "IfcQuantityArea",
            Self::Volume => "IfcQuantityVolume",
            Self::Count => "IfcQuantityCount",
            Self::Weight => "IfcQuantityWeight",
            Self::Time => "IfcQuantityTime",
            Self::Number => "IfcQuantityNumber",
        }
    }
}

/// The kinds a consumer reads: `Number` only in the opt-in analysis view
/// (flat exports drop it until C6-14).
/// Where every simple quantity (`IfcQuantityLength`, `Area`, `Volume`, `Count`,
/// `Number`, `Weight`, `Time`) keeps its value. The seven classes share no
/// supertype that declares it, so the position is named once here and the
/// assertions below fail the build if any class disagrees.
const QUANTITY_VALUE: usize = slot::IfcQuantityLength::LENGTH_VALUE.index();
const _: () = {
    assert!(slot::IfcQuantityArea::AREA_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityVolume::VOLUME_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityCount::COUNT_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityNumber::NUMBER_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityWeight::WEIGHT_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityTime::TIME_VALUE.index() == QUANTITY_VALUE);
};

fn quantity_kind(ty: &IfcType, mode: QuantityDecodeMode) -> Option<QuantityKind> {
    QuantityKind::of(ty).filter(|k| *k != QuantityKind::Number || matches!(mode, QuantityDecodeMode::AuthoredAnalysis))
}

/// Decode one `IfcElementQuantity` definition into our model.
pub fn decode_quantity_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<QuantitySet> {
    let decoded = decode_quantity_records(decoder, def, None, QuantityDecodeMode::FlatExport)?;
    let quantities = decoded.records.into_iter().map(|record| record.value).collect();
    Some(QuantitySet { name: decoded.name, quantities })
}

/// The quantity kinds each consumer has historically read.
#[derive(Clone, Copy)]
pub enum QuantityDecodeMode {
    /// Preserve the existing flat-export set of kinds.
    FlatExport,
    /// Include IFC4X3 Number in the opt-in view.
    AuthoredAnalysis,
}

pub struct QuantityRecord {
    pub id: u32,
    pub unit_id: Option<u32>,
    pub invalid_unit_ref: bool,
    pub value: QuantityValue,
}

pub struct QuantityRecordDecode {
    pub name: String,
    pub records: Vec<QuantityRecord>,
    pub rejected_members: usize,
    pub first_rejected_id: Option<u32>,
}

/// Parse physical quantities once while preserving the provenance needed by the
/// opt-in view. Flat exports discard that metadata and retain their old scope.
pub fn decode_quantity_records(
    decoder: &mut EntityDecoder, def: &DecodedEntity, max_members: Option<usize>,
    mode: QuantityDecodeMode,
) -> Option<QuantityRecordDecode> {
    let name = def.string_at(slot::IfcElementQuantity::NAME).unwrap_or("").to_string();
    let quantities_attr = def.attr(slot::IfcElementQuantity::QUANTITIES)?;
    if max_members.is_some_and(|max| quantities_attr.as_list().is_none_or(|items| items.len() > max)) {
        return None;
    }
    let quants = decoder.resolve_ref_list(quantities_attr).ok()?;
    let mut records = Vec::new();
    let mut rejected_members = 0;
    let mut first_rejected_id = None;
    for q in &quants {
        // The slots are read only for a class that has them: a leaf that is not
        // a quantity (an `IfcPropertySingleValue`) is a rejected member.
        let parsed = quantity_kind(&q.ifc_type, mode).and_then(|kind| {
            let qname = q.string_at(slot::IfcPhysicalQuantity::NAME).filter(|name| !name.is_empty())?;
            // as_float already accepts STEP integers, including authored Count.
            Some((kind, qname, q.real_at(QUANTITY_VALUE)?))
        });
        let Some((kind, qname, value)) = parsed else {
            rejected_members += 1;
            first_rejected_id.get_or_insert(q.id);
            continue;
        };
        records.push(QuantityRecord {
            id: q.id,
            unit_id: q.ref_at(slot::IfcPhysicalSimpleQuantity::UNIT),
            invalid_unit_ref: q.attr(slot::IfcPhysicalSimpleQuantity::UNIT).is_some_and(|unit| !unit.is_null() && unit.as_entity_ref().is_none()),
            value: QuantityValue { name: qname.to_string(), value, kind: kind.as_str() },
        });
    }
    Some(QuantityRecordDecode { name, records, rejected_members, first_rejected_id })
}


#[cfg(test)]
#[path = "quantity_tests.rs"]
mod tests;
