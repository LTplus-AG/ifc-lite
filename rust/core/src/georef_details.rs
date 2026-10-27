// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::GeoRefSource;

/// The authored coordinate operation, independent of the compatible placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CoordinateOperationKind {
    /// `IfcMapConversion`, including its `Scaled` subtype.
    MapConversion,
    /// `IfcRigidOperation`, a pure translation into its target CRS.
    RigidOperation,
}

/// Additional metadata returned by `GeoRefExtractor::extract_with_details`.
///
/// Kept separate so existing callers can still construct `GeoReference`
/// exhaustively and match every `GeoRefSource` variant.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct GeoReferenceDetails {
    /// The parsed coordinate operation; absent for CRS-only and legacy data.
    pub operation: Option<CoordinateOperationKind>,
    /// Trimmed `IfcWellKnownText.WellKnownText` attached to the selected CRS.
    /// When present, this is the authoritative definition, even without a name.
    pub well_known_text: Option<String>,
}

impl GeoReferenceDetails {
    /// Precise wire provenance, including rigid operations, or the base label.
    pub fn source_label(&self, base: Option<GeoRefSource>) -> Option<&'static str> {
        if self.operation == Some(CoordinateOperationKind::RigidOperation) {
            Some("rigidOperation")
        } else {
            base.map(GeoRefSource::label)
        }
    }
}
