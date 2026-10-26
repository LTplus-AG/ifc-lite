// SPDX-License-Identifier: MPL-2.0
//! The four schema families this workspace converts between and labels files
//! with: IFC2X3, IFC4, IFC4X3 and IFC5 (C6-1, D44).
//!
//! This is the ONE classifier of a `FILE_SCHEMA` label into a family. Before it
//! existed the same prefix test was spelled in export's `canon`, step_log's
//! `schema_family`, processing's `schema_of_identifier` and two `starts_with`
//! allowlists, each with its own order, trimming and fallback.
//!
//! Lookups return `Option`: a label that names no family is `None`, and every
//! caller states its own default (IFC4 for re-export, fail closed for reads by
//! attribute name). That is the whole point; there is no default here.
//!
//! [`SchemaVersion::from_file_schema`](crate::SchemaVersion::from_file_schema)
//! stays the registry selector (exact family plus `_ADD`/`_TC`/`_RC` suffixes).
//! A family is looser by design: any label that begins with the family name.

use crate::parser::header::first_declared_schema;
use crate::SchemaVersion;

/// Bytes of the source the last-resort scan reads when no declared identifier
/// names a family. The TS parser's figure (`detectSchemaVersion`).
const FALLBACK_SCAN_BYTES: usize = 2000;

/// Family names, longest first: `IFC4X3` begins with `IFC4`.
const FAMILIES: [SchemaFamily; 4] =
    [SchemaFamily::Ifc5, SchemaFamily::Ifc4x3, SchemaFamily::Ifc4, SchemaFamily::Ifc2x3];

/// An IFC schema family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SchemaFamily {
    Ifc2x3,
    Ifc4,
    Ifc4x3,
    Ifc5,
}

impl SchemaFamily {
    /// The canonical name: `IFC2X3`, `IFC4`, `IFC4X3` or `IFC5`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ifc2x3 => "IFC2X3",
            Self::Ifc4 => "IFC4",
            Self::Ifc4x3 => "IFC4X3",
            Self::Ifc5 => "IFC5",
        }
    }

    /// The family a `FILE_SCHEMA` label names, by prefix after trimming,
    /// ASCII-case-insensitively and longest family first (`IFC4X3_ADD2`,
    /// `IFC2X3_TC1` and `IFC4X1` all occur in the wild). `IFCX` is IFC5.
    /// `None` for a label naming no family.
    pub fn from_label(label: &str) -> Option<Self> {
        Self::from_step_label(label).or_else(|| {
            let t = label.trim();
            (t.len() >= 4 && t.as_bytes()[..4].eq_ignore_ascii_case(b"IFCX")).then_some(Self::Ifc5)
        })
    }

    /// [`Self::from_label`] without the `IFCX` alias: the labels a STEP header
    /// can declare. The TS twin (`detectSchemaVersion`) has no `IFCX` either.
    fn from_step_label(label: &str) -> Option<Self> {
        let t = label.trim().as_bytes();
        FAMILIES.into_iter().find(|f| {
            let name = f.as_str().as_bytes();
            t.len() >= name.len() && t[..name.len()].eq_ignore_ascii_case(name)
        })
    }

    /// The family a STEP file declares, by the rule of the TS parser's
    /// `detectSchemaVersion`, pinned by
    /// `tests/fixtures/schema_version_vectors.json`:
    /// 1. the first `FILE_SCHEMA` identifier that names a family wins (the
    ///    shared [`first_declared_schema`] selection);
    /// 2. else the first 2000 bytes are searched for a family token, ASCII
    ///    case-insensitively (a loose last resort, as the TS twin does);
    /// 3. else `None`.
    pub fn detect(content: &[u8]) -> Option<Self> {
        first_declared_schema(content, Self::from_step_label).or_else(|| {
            let head = &content[..content.len().min(FALLBACK_SCAN_BYTES)];
            let text = String::from_utf8_lossy(head).to_ascii_uppercase();
            FAMILIES.into_iter().find(|f| text.contains(f.as_str()))
        })
    }

    /// The family of a `FILE_SCHEMA` label by the registry selector: the
    /// family of [`SchemaVersion::from_file_schema`]'s version, and `IFC5`
    /// (which has no bundled registry) for the label `IFC5`. Stricter than
    /// [`Self::from_label`]: `IFC4FOO` names no family here.
    pub fn of_file_schema(label: &str) -> Option<Self> {
        SchemaVersion::from_file_schema(label)
            .map(Self::of)
            .or_else(|| label.trim().eq_ignore_ascii_case("IFC5").then_some(Self::Ifc5))
    }

    /// The family of a bundled registry version (`Ifc4x1`, `Ifc4x2` are IFC4).
    pub const fn of(version: SchemaVersion) -> Self {
        match version {
            SchemaVersion::Ifc2x3 => Self::Ifc2x3,
            SchemaVersion::Ifc4 | SchemaVersion::Ifc4x1 | SchemaVersion::Ifc4x2 => Self::Ifc4,
            SchemaVersion::Ifc4x3 => Self::Ifc4x3,
        }
    }
}

#[cfg(test)]
#[path = "schema_family_tests.rs"]
mod tests;
