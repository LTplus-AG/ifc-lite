// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`ScanClass`]: the one table of STEP keywords a scan loop reacts to.
//!
//! Every pre-pass used to spell its own keyword chain: the native scan, the
//! browser's serial pre-pass, [`PrepassSpans::stash`](crate::prepass::PrepassSpans::stash)
//! and the sharded scan's `classify_type_name` each compared the same
//! keywords in their own order. A keyword added to one and not the others was
//! a silent drift between pipelines (#858/#913 class). This is the table; each
//! scan matches on the class instead of re-comparing text.
//!
//! [`ScanClass::classify`] is a case-insensitive match on the keyword's length
//! followed by at most three same-length comparisons, with no allocation. It
//! returns exactly what the chain `keyword_eq(.., A) || keyword_eq(.., B) ..`
//! returned for the same string (`scan_class_matches_the_keyword_chain` pins
//! that over every schema type name and the spelling variants).

use ifc_lite_core::keyword_starts_with;

/// What a scan loop does with a record, decided from its keyword alone.
///
/// `Other` is everything else: the scan then asks the schema helpers whether
/// the record is a geometry job or a type product.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScanClass {
    /// `IFCSTYLEDITEM`.
    StyledItem,
    /// `IFCINDEXEDCOLOURMAP`.
    IndexedColourMap,
    /// `IFCMATERIALDEFINITIONREPRESENTATION`.
    MaterialDefinitionRepresentation,
    /// `IFCRELASSOCIATESMATERIAL`.
    RelAssociatesMaterial,
    /// `IFCRELVOIDSELEMENT`.
    RelVoidsElement,
    /// `IFCRELFILLSELEMENT`.
    RelFillsElement,
    /// `IFCRELAGGREGATES`.
    RelAggregates,
    /// `IFCRELDEFINESBYTYPE`.
    RelDefinesByType,
    /// `IFCMAPPEDITEM`.
    MappedItem,
    /// `IFCPROJECT`.
    Project,
    /// `IFCSITE` (also a geometry job).
    Site,
    /// `IFCBUILDING` (a geometry job only when its `Representation` is set, #1910).
    Building,
    /// `IFCMATERIALLAYERSET` / `IFCMATERIALLAYERSETUSAGE`.
    MaterialLayerSet,
    /// `IFCPRESENTATIONLAYERASSIGNMENT`.
    PresentationLayerAssignment,
    /// `IFCPROPERTYSET`.
    PropertySet,
    /// `IFCRELDEFINESBYPROPERTIES`.
    RelDefinesByProperties,
    /// Any other `IFCPROPERTY...` record (single values, enumerations, ...).
    Property,
    /// No scan-time reaction by keyword.
    Other,
}

/// Case-insensitive equality against an uppercase keyword, on bytes.
#[inline(always)]
fn is(raw: &[u8], upper: &str) -> bool {
    raw.eq_ignore_ascii_case(upper.as_bytes())
}

impl ScanClass {
    /// Classify a scanned keyword (any case, as the file spelled it).
    #[inline]
    pub fn classify(type_name: &str) -> Self {
        let raw = type_name.as_bytes();
        // Length first: all but a few records differ in length from every
        // keyword, so the common record costs one jump and no comparison.
        let class = match raw.len() {
            7 if is(raw, "IFCSITE") => Self::Site,
            10 if is(raw, "IFCPROJECT") => Self::Project,
            11 if is(raw, "IFCBUILDING") => Self::Building,
            13 if is(raw, "IFCSTYLEDITEM") => Self::StyledItem,
            13 if is(raw, "IFCMAPPEDITEM") => Self::MappedItem,
            14 if is(raw, "IFCPROPERTYSET") => Self::PropertySet,
            16 if is(raw, "IFCRELAGGREGATES") => Self::RelAggregates,
            18 if is(raw, "IFCRELVOIDSELEMENT") => Self::RelVoidsElement,
            18 if is(raw, "IFCRELFILLSELEMENT") => Self::RelFillsElement,
            19 if is(raw, "IFCINDEXEDCOLOURMAP") => Self::IndexedColourMap,
            19 if is(raw, "IFCRELDEFINESBYTYPE") => Self::RelDefinesByType,
            19 if is(raw, "IFCMATERIALLAYERSET") => Self::MaterialLayerSet,
            24 if is(raw, "IFCRELASSOCIATESMATERIAL") => Self::RelAssociatesMaterial,
            24 if is(raw, "IFCMATERIALLAYERSETUSAGE") => Self::MaterialLayerSet,
            25 if is(raw, "IFCRELDEFINESBYPROPERTIES") => Self::RelDefinesByProperties,
            30 if is(raw, "IFCPRESENTATIONLAYERASSIGNMENT") => Self::PresentationLayerAssignment,
            35 if is(raw, "IFCMATERIALDEFINITIONREPRESENTATION") => {
                Self::MaterialDefinitionRepresentation
            }
            _ => Self::Other,
        };
        if class == Self::Other && keyword_starts_with(type_name, "IFCPROPERTY") {
            return Self::Property;
        }
        class
    }

    /// The sharded scan's class code for this keyword, or
    /// [`PREPASS_CLASS_NONE`](crate::PREPASS_CLASS_NONE) for the classes that scan does not name.
    pub fn wire_code(self) -> u8 {
        use crate::shard_classes as w;
        match self {
            Self::Project => w::PREPASS_CLASS_PROJECT,
            Self::Site => w::PREPASS_CLASS_SITE,
            Self::StyledItem => w::PREPASS_CLASS_STYLED_ITEM,
            Self::IndexedColourMap => w::PREPASS_CLASS_INDEXED_COLOUR_MAP,
            Self::MaterialDefinitionRepresentation => w::PREPASS_CLASS_MATERIAL_DEF_REPR,
            Self::RelAssociatesMaterial => w::PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
            Self::RelVoidsElement => w::PREPASS_CLASS_REL_VOIDS,
            Self::RelFillsElement => w::PREPASS_CLASS_REL_FILLS,
            Self::RelAggregates => w::PREPASS_CLASS_REL_AGGREGATES,
            Self::MappedItem => w::PREPASS_CLASS_MAPPED_ITEM,
            Self::RelDefinesByType => w::PREPASS_CLASS_REL_DEFINES_BY_TYPE,
            Self::MaterialLayerSet => w::PREPASS_CLASS_MATERIAL_LAYER_SET,
            Self::Building
            | Self::PresentationLayerAssignment
            | Self::PropertySet
            | Self::RelDefinesByProperties
            | Self::Property
            | Self::Other => w::PREPASS_CLASS_NONE,
        }
    }
}

impl From<ScanClass> for u8 {
    /// The shard wire code ([`ScanClass::wire_code`]).
    fn from(class: ScanClass) -> u8 {
        class.wire_code()
    }
}

impl TryFrom<u8> for ScanClass {
    type Error = u8;

    /// The class a shard wire code names; flag bits must already be masked off
    /// (`PREPASS_CLASS_CODE_MASK`). `PREPASS_CLASS_NONE` and unknown codes are `Err(code)`.
    fn try_from(code: u8) -> Result<Self, u8> {
        use crate::shard_classes as w;
        Ok(match code {
            w::PREPASS_CLASS_PROJECT => Self::Project,
            w::PREPASS_CLASS_SITE => Self::Site,
            w::PREPASS_CLASS_STYLED_ITEM => Self::StyledItem,
            w::PREPASS_CLASS_INDEXED_COLOUR_MAP => Self::IndexedColourMap,
            w::PREPASS_CLASS_MATERIAL_DEF_REPR => Self::MaterialDefinitionRepresentation,
            w::PREPASS_CLASS_REL_ASSOCIATES_MATERIAL => Self::RelAssociatesMaterial,
            w::PREPASS_CLASS_REL_VOIDS => Self::RelVoidsElement,
            w::PREPASS_CLASS_REL_FILLS => Self::RelFillsElement,
            w::PREPASS_CLASS_REL_AGGREGATES => Self::RelAggregates,
            w::PREPASS_CLASS_MAPPED_ITEM => Self::MappedItem,
            w::PREPASS_CLASS_REL_DEFINES_BY_TYPE => Self::RelDefinesByType,
            w::PREPASS_CLASS_MATERIAL_LAYER_SET => Self::MaterialLayerSet,
            other => return Err(other),
        })
    }
}

#[cfg(test)]
#[path = "scan_tests.rs"]
mod scan_tests;
