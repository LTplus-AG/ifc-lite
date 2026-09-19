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
    Ifc4x3,
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
            Self::Ifc4x3 => attribute_names_ifc4x3(entity_name),
        }
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

fn attribute_names_ifc4(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::ifc4::IfcType::from_str(name);
    if matches!(ty, super::ifc4::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

fn attribute_names_ifc4x3(name: &str) -> Option<&'static [&'static str]> {
    let ty = super::schema::IfcType::from_str(name);
    if matches!(ty, super::schema::IfcType::Unknown(_)) {
        None
    } else {
        Some(ty.attribute_names())
    }
}

/// Attribute names for an entity in the source schema named by `FILE_SCHEMA`.
pub fn attribute_names_for_schema(
    file_schema: &str,
    entity_name: &str,
) -> Option<&'static [&'static str]> {
    SchemaVersion::from_file_schema(file_schema)?.attribute_names(entity_name)
}
