// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Generated EXPRESS schema registry selection.
//!
//! The three registry modules are generated independently from the committed
//! IFC2X3, IFC4, and IFC4X3 EXPRESS inputs.  The canonical [`super::IfcType`]
//! remains the IFC4X3 type used by parsing and geometry; this module exists
//! only for questions whose answer is defined by the source file's schema,
//! such as positional attribute names.

/// The EXPRESS schema families bundled in the Rust registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SchemaVersion {
    Ifc2x3,
    Ifc4,
    Ifc4x1,
    Ifc4x2,
    Ifc4x3,
}

/// Schema-local facts about one declared entity.
///
/// These facts come from the independently generated registry for the source
/// schema, not from the public merged type universe (#4203).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaEntityInfo {
    pub name: &'static str,
    pub parent: Option<&'static str>,
    pub is_abstract: bool,
}

impl SchemaVersion {
    /// Resolve a STEP `FILE_SCHEMA` label to a bundled schema family.
    ///
    /// Addendum, corrigendum, and release-candidate suffixes share their
    /// family's bundled EXPRESS registry. Unknown labels deliberately return
    /// `None`: guessing a nearby schema could relabel a positional value
    /// incorrectly.
    pub fn from_file_schema(label: &str) -> Option<Self> {
        let upper = label.trim().to_ascii_uppercase();
        if is_schema_family(&upper, "IFC4X3") {
            Some(Self::Ifc4x3)
        } else if is_schema_family(&upper, "IFC4X2") {
            Some(Self::Ifc4x2)
        } else if is_schema_family(&upper, "IFC4X1") {
            Some(Self::Ifc4x1)
        } else if is_schema_family(&upper, "IFC4") {
            Some(Self::Ifc4)
        } else if is_schema_family(&upper, "IFC2X3") {
            Some(Self::Ifc2x3)
        } else {
            None
        }
    }

    /// Attribute names for `entity_name` in this schema, or `None` when the
    /// entity is not declared by this schema. A declared entity with no
    /// attributes returns `Some(&[])` so callers never confuse it with absent.
    pub fn attribute_names(self, entity_name: &str) -> Option<&'static [&'static str]> {
        match self {
            Self::Ifc2x3 => attribute_names_ifc2x3(entity_name),
            Self::Ifc4 => attribute_names_ifc4(entity_name),
            Self::Ifc4x1 => attribute_names_ifc4x1(entity_name),
            Self::Ifc4x2 => attribute_names_ifc4x2(entity_name),
            Self::Ifc4x3 => attribute_names_ifc4x3(entity_name),
        }
    }

    /// Membership, direct parent, and abstractness from this schema's EXPRESS
    /// declaration. Unknown names fail closed.
    pub fn entity_info(self, entity_name: &str) -> Option<SchemaEntityInfo> {
        match self {
            Self::Ifc2x3 => entity_info_ifc2x3(entity_name),
            Self::Ifc4 => entity_info_ifc4(entity_name),
            Self::Ifc4x1 => entity_info_ifc4x1(entity_name),
            Self::Ifc4x2 => entity_info_ifc4x2(entity_name),
            Self::Ifc4x3 => entity_info_ifc4x3(entity_name),
        }
    }

    /// Whether `child` inherits from `parent` in this schema's own graph.
    pub fn is_subtype_of(self, child: &str, parent: &str) -> bool {
        let mut current = self.entity_info(child);
        while let Some(info) = current {
            if info.name.eq_ignore_ascii_case(parent) {
                return true;
            }
            current = info.parent.and_then(|name| self.entity_info(name));
        }
        false
    }
}

/// Exact family name, optionally followed by standard revision components
/// such as `_ADD2`, `_TC1`, or `_RC4`.
fn is_schema_family(label: &str, family: &str) -> bool {
    let Some(suffix) = label.strip_prefix(family) else {
        return false;
    };
    if suffix.is_empty() {
        return true;
    }
    let Some(revision) = suffix.strip_prefix('_') else {
        return false;
    };
    revision.split('_').all(|component| {
        ["ADD", "TC", "RC"].iter().any(|prefix| {
            component.strip_prefix(prefix).is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
            })
        })
    })
}

fn attribute_names_ifc2x3(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::ifc2x3::IfcType::from_str(name);
    if matches!(ty, super::ifc2x3::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

fn entity_info_ifc2x3(name: &str) -> Option<SchemaEntityInfo> {
    let ty = super::ifc2x3::IfcType::from_str(name);
    if matches!(ty, super::ifc2x3::IfcType::Unknown(_)) {
        None
    } else {
        Some(SchemaEntityInfo {
            name: ty.known_as_str()?,
            parent: ty.parent().and_then(|parent| parent.known_as_str()),
            is_abstract: ty.is_abstract(),
        })
    }
}

fn attribute_names_ifc4(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::ifc4::IfcType::from_str(name);
    if matches!(ty, super::ifc4::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

fn entity_info_ifc4(name: &str) -> Option<SchemaEntityInfo> {
    let ty = super::ifc4::IfcType::from_str(name);
    if matches!(ty, super::ifc4::IfcType::Unknown(_)) {
        None
    } else {
        Some(SchemaEntityInfo {
            name: ty.known_as_str()?,
            parent: ty.parent().and_then(|parent| parent.known_as_str()),
            is_abstract: ty.is_abstract(),
        })
    }
}

fn attribute_names_ifc4x1(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::ifc4x1::IfcType::from_str(name);
    if matches!(ty, super::ifc4x1::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

fn entity_info_ifc4x1(name: &str) -> Option<SchemaEntityInfo> {
    let ty = super::ifc4x1::IfcType::from_str(name);
    if matches!(ty, super::ifc4x1::IfcType::Unknown(_)) {
        None
    } else {
        Some(SchemaEntityInfo {
            name: ty.known_as_str()?,
            parent: ty.parent().and_then(|parent| parent.known_as_str()),
            is_abstract: ty.is_abstract(),
        })
    }
}

fn attribute_names_ifc4x2(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::ifc4x2::IfcType::from_str(name);
    if matches!(ty, super::ifc4x2::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

fn entity_info_ifc4x2(name: &str) -> Option<SchemaEntityInfo> {
    let ty = super::ifc4x2::IfcType::from_str(name);
    if matches!(ty, super::ifc4x2::IfcType::Unknown(_)) {
        None
    } else {
        Some(SchemaEntityInfo {
            name: ty.known_as_str()?,
            parent: ty.parent().and_then(|parent| parent.known_as_str()),
            is_abstract: ty.is_abstract(),
        })
    }
}

fn attribute_names_ifc4x3(name: &str) -> Option<&'static [&'static str]> {
    // The canonical enum is the whole supported-schema universe (#4203): a
    // legacy class such as IfcDoorStyle resolves to an exact variant there,
    // but IFC4X3 does not declare it, so this registry must still answer
    // `None` rather than lend it an empty (or borrowed) slot layout.
    let ty = super::schema::IfcType::from_str(name);
    if ty.declared_by_canonical_schema() {
        Some(ty.attribute_names())
    } else {
        None
    }
}

fn entity_info_ifc4x3(name: &str) -> Option<SchemaEntityInfo> {
    let ty = super::schema::IfcType::from_str(name);
    if !ty.declared_by_canonical_schema() {
        return None;
    }
    Some(SchemaEntityInfo {
        name: ty.known_as_str()?,
        parent: ty.parent().and_then(|parent| parent.known_as_str()),
        is_abstract: ty.is_abstract(),
    })
}

/// Attribute names for an entity in the source schema named by `FILE_SCHEMA`.
pub fn attribute_names_for_schema(
    file_schema: &str,
    entity_name: &str,
) -> Option<&'static [&'static str]> {
    SchemaVersion::from_file_schema(file_schema)?.attribute_names(entity_name)
}

/// Schema-local facts for an entity in the source schema named by
/// `FILE_SCHEMA`.
pub fn entity_info_for_schema(file_schema: &str, entity_name: &str) -> Option<SchemaEntityInfo> {
    SchemaVersion::from_file_schema(file_schema)?.entity_info(entity_name)
}

/// Schema-local inheritance test for a source `FILE_SCHEMA`.
pub fn is_subtype_of_for_schema(file_schema: &str, child: &str, parent: &str) -> bool {
    SchemaVersion::from_file_schema(file_schema).is_some_and(|schema| schema.is_subtype_of(child, parent))
}
