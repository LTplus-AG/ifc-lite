/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

pub type LandXmlProperties = BTreeMap<String, String>;

/// Stable, machine-readable reason for an ingestion refusal or invalid source.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum LandXmlDiagnosticCode {
    InputTooLarge,
    DtdForbidden,
    EntityForbidden,
    LimitExceeded,
    Cancelled,
    InvalidXml,
    UnsupportedNamespace,
    UnsupportedVersion,
    InvalidSemantic,
}

impl LandXmlDiagnosticCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InputTooLarge => "LXML001",
            Self::DtdForbidden => "LXML002",
            Self::EntityForbidden => "LXML003",
            Self::LimitExceeded => "LXML004",
            Self::Cancelled => "LXML005",
            Self::InvalidXml => "LXML006",
            Self::UnsupportedNamespace => "LXML007",
            Self::UnsupportedVersion => "LXML008",
            Self::InvalidSemantic => "LXML009",
        }
    }
}

/// Parse failure with a stable code suitable for native/server/wasm mapping.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlError {
    pub code: LandXmlDiagnosticCode,
    pub message: String,
}

impl LandXmlError {
    pub fn new(code: LandXmlDiagnosticCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for LandXmlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for LandXmlError {}

/// Capability selected from the root LandXML namespace and version attribute.
///
/// The parser deliberately supports TIN ingestion for 1.2 only. Earlier
/// versions remain explicit states instead of being misclassified as arbitrary
/// XML, so callers can show an actionable refusal and add a future adapter
/// without changing classification semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlVersionCapability {
    NotLandXml,
    LandXml10Unsupported,
    LandXml11Unsupported,
    LandXml12Tin,
    LandXml12VersionMismatch,
}

impl LandXmlVersionCapability {
    pub const fn supports_tin_ingestion(self) -> bool {
        matches!(self, Self::LandXml12Tin)
    }
}

/// Deterministic source identifier; it is not derived from any output mesh.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct LandXmlSourceId(pub String);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPoint {
    /// Stable semantic identity, never a renderer mesh or vertex index.
    pub source_id: LandXmlSourceId,
    pub id: String,
    pub northing: f64,
    pub easting: f64,
    pub elevation: f64,
}

/// Coordinates from `Surface/SourceData/DataPoints`, separate from face ids.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSourcePoint {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub source_path: String,
    pub coordinate_dimension: u8,
    pub coordinates: Vec<f64>,
}

/// Source topology classification declared by a `Surface/Definition`.
///
/// It deliberately describes the source, rather than promising that an
/// adapter can render it.  In particular, a GRID or volume surface is kept as
/// source data and is never guessed into a TIN.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlSurfaceKind {
    Tin,
    Grid,
    Volume,
    Other,
}

/// Honest presentation state for one source surface.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlRenderState {
    /// TIN source faces are available to a rendering adapter.
    Rendered,
    /// The source is retained but this crate has no topology adapter for it.
    PreservedOnly,
    /// The source declaration is known to be unsupported.
    Unsupported,
}

/// One preserved source line/ring (boundary, breakline, or contour).
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPolyline {
    pub source_id: LandXmlSourceId,
    /// One-based ordinal within its containing overlay category.
    pub ordinal: usize,
    pub name: Option<String>,
    /// Producer-declared subtype (`bndType`, `brkType`, or contour type).
    pub kind: Option<String>,
    pub source_path: String,
    pub properties: LandXmlProperties,
    /// Two- or three-dimensional coordinates in authored axis order.
    pub coordinate_dimension: u8,
    pub points: Vec<Vec<f64>>,
    /// Stable, ordered ids for vertices authored as coordinate lists. LandXML
    /// PntList3D has no P reference to preserve, so these are source vertices,
    /// not guessed terrain point references.
    pub point_source_ids: Vec<LandXmlSourceId>,
}

/// A non-LandXML namespace root retained for diagnostics and later adapters.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlExtension {
    pub namespace: String,
    pub local_name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSurface {
    pub source_id: LandXmlSourceId,
    /// One-based source order under `LandXML/Surfaces`.
    pub ordinal: usize,
    pub source_path: String,
    pub properties: LandXmlProperties,
    pub definition_properties: LandXmlProperties,
    pub name: String,
    pub kind: LandXmlSurfaceKind,
    pub render_state: LandXmlRenderState,
    pub points: Vec<LandXmlPoint>,
    pub source_data_points: Vec<LandXmlSourcePoint>,
    pub faces: Vec<[String; 3]>,
    /// Mirrors `faces` by ordinal.  A face's identity remains stable when an
    /// adapter splits, drops, or reorders meshes for precision.
    pub face_source_ids: Vec<LandXmlSourceId>,
    /// Visibility is source topology, aligned to `faces` and `face_source_ids`.
    /// Hidden faces are preserved but never sent to the rendering adapter.
    pub face_visibility: Vec<bool>,
    pub hidden_face_count: usize,
    pub boundaries: Vec<LandXmlPolyline>,
    pub breaklines: Vec<LandXmlPolyline>,
    pub contours: Vec<LandXmlPolyline>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlUnits {
    pub linear_unit: String,
    pub elevation_unit: String,
    pub linear_scale_to_meters: f64,
    pub elevation_scale_to_meters: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlTinDocument {
    pub format: String,
    pub schema: String,
    pub capabilities: LandXmlCapabilities,
    pub version: String,
    /// Missing only in a geometry-free source that has no unit declaration.
    /// The document remains inspectable; consumers must refuse meter-based
    /// operations until a later georeferencing adapter supplies units.
    pub units: Option<LandXmlUnits>,
    pub surfaces: Vec<LandXmlSurface>,
    pub extensions: Vec<LandXmlExtension>,
    pub warnings: Vec<String>,
    /// Horizontal alignments are source records, separate from terrain TINs.
    pub alignments: Vec<crate::LandXmlAlignment>,
    /// Design and sampled profiles retain their distinct LandXML source kinds.
    pub profiles: Vec<crate::LandXmlProfile>,
    pub cross_sections: Vec<crate::LandXmlCrossSection>,
    pub cross_section_surfaces: Vec<crate::LandXmlCrossSectionSurface>,
    pub roadways: Vec<crate::LandXmlRoadway>,
    pub capability_diagnostics: Vec<crate::LandXmlCapabilityDiagnostic>,
    pub preserved_only_extensions: Vec<crate::LandXmlPreservedOnlyExtension>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlCapabilities {
    pub renderable_tin: bool,
    pub preserved_only_surfaces: usize,
    pub unknown_extensions: usize,
}
