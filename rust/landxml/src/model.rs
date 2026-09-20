/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::fmt;

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
    pub id: String,
    pub northing: f64,
    pub easting: f64,
    pub elevation: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSurface {
    pub source_id: LandXmlSourceId,
    pub name: String,
    pub points: Vec<LandXmlPoint>,
    pub faces: Vec<[String; 3]>,
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
    pub version: String,
    pub units: LandXmlUnits,
    pub surfaces: Vec<LandXmlSurface>,
    pub warnings: Vec<String>,
}
