// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Georeferencing extraction for the HTTP server response.
//!
//! The browser parser (`@ifc-lite/parse`) exposes `IfcMapConversion` /
//! `IfcProjectedCRS` georeferencing via `extractGeoreferencing`. The server
//! previously surfaced only a coarse `is_geo_referenced` boolean, so consumers
//! couldn't recover the real-world CRS, false eastings/northings, or grid-north
//! rotation. This module reuses the shared `ifc_lite_core::GeoRefExtractor`
//! (the same extraction the desktop/native paths use) and maps it into a
//! serializable, server-friendly shape carried inline on every geometry
//! endpoint's `ModelMetadata` (issue #900 parity follow-up).

use std::sync::Arc;

use ifc_lite_core::{EntityDecoder, EntityIndex, EntityScanner, GeoRefExtractor, IfcType};
use serde::{Deserialize, Serialize};

/// Georeferencing metadata (`IfcMapConversion` + `IfcProjectedCRS`).
///
/// Mirrors `ifc_lite_core::GeoReference` with two derived conveniences
/// (`rotation_degrees`, `transform_matrix`) so consumers don't have to
/// recompute the rotation or the local→map matrix.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Georeferencing {
    /// Projected CRS name from `IfcProjectedCRS.Name` (e.g. `"EPSG:32632"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crs_name: Option<String>,
    /// Geodetic datum (e.g. `"WGS84"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geodetic_datum: Option<String>,
    /// Vertical datum (e.g. `"NAVD88"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_datum: Option<String>,
    /// Map projection (e.g. `"UTM"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_projection: Option<String>,
    /// False easting — X offset to the map CRS, in the project's length unit.
    pub eastings: f64,
    /// False northing — Y offset to the map CRS, in the project's length unit.
    pub northings: f64,
    /// Orthogonal height — Z offset to the map CRS.
    pub orthogonal_height: f64,
    /// X-axis abscissa: cosine of the rotation to grid north.
    pub x_axis_abscissa: f64,
    /// X-axis ordinate: sine of the rotation to grid north.
    pub x_axis_ordinate: f64,
    /// Scale factor applied during the local→map transform (default `1.0`).
    pub scale: f64,
    /// Rotation to grid north in degrees, derived from the X-axis direction.
    pub rotation_degrees: f64,
    /// Local→map transform as a column-major 4×4 matrix (16 values).
    pub transform_matrix: [f64; 16],
    /// CRS description from `IfcProjectedCRS.Description`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub crs_description: Option<String>,
    /// Map zone (e.g. `"32N"`) from `IfcProjectedCRS.MapZone`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub map_zone: Option<String>,
    /// Map unit name resolved from `IfcProjectedCRS.MapUnit` (e.g. `"METRE"`,
    /// `"MILLIMETRE"`); absent when no MapUnit is authored.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub map_unit: Option<String>,
    /// Scale factor converting MapConversion values to metres (0.001 for
    /// millimetres); absent when no MapUnit is authored.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub map_unit_scale: Option<f64>,
    /// Provenance: `"mapConversion"`, `"ePSetMapConversion"`, or
    /// `"siteLocation"` — same labels as the TS parser's
    /// `GeoreferenceInfo.source`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
}

impl Georeferencing {
    fn from_core(geo: &ifc_lite_core::GeoReference) -> Self {
        Self {
            crs_name: geo.crs_name.clone(),
            geodetic_datum: geo.geodetic_datum.clone(),
            vertical_datum: geo.vertical_datum.clone(),
            map_projection: geo.map_projection.clone(),
            eastings: geo.eastings,
            northings: geo.northings,
            orthogonal_height: geo.orthogonal_height,
            x_axis_abscissa: geo.x_axis_abscissa,
            x_axis_ordinate: geo.x_axis_ordinate,
            scale: geo.scale,
            rotation_degrees: geo.rotation().to_degrees(),
            transform_matrix: geo.to_matrix(),
            crs_description: geo.crs_description.clone(),
            map_zone: geo.map_zone.clone(),
            map_unit: geo.map_unit.clone(),
            map_unit_scale: geo.map_unit_scale,
            source: Some(geo.source.label().to_string()),
        }
    }
}

/// Extract georeferencing from an IFC file, returning `None` when the model
/// carries no `IfcMapConversion` / `ePSet_MapConversion` data.
///
/// Only the entity types the extractor needs (`IfcMapConversion`,
/// `IfcProjectedCRS`, and `IfcPropertySet` for the IFC2x3 `ePSet_MapConversion`
/// fallback) are collected from the scan — their `IfcType` is known from the
/// entity name, so no decoding happens while building the candidate list.
pub fn extract_georeferencing<T>(content: &T) -> Option<Georeferencing>
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    // Parallel on native (byte-identical to `build_entity_index`), serial on wasm.
    let entity_index = Arc::new(crate::build_entity_index_parallel(content));
    extract_georeferencing_with_index(content, &entity_index)
}

/// [`extract_georeferencing`], reusing an index the caller already holds.
///
/// The extractor resolves its references by id, so this pass genuinely needs an
/// index; what it does not need is a second one. A caller that has already
/// scanned the file (the geometry pipeline holds one for its whole run) was
/// paying a full extra scan to build a map it had in hand.
///
/// `entity_index` must have been built from this same `content`. Given that, the
/// result is identical to the wrapper's.
pub fn extract_georeferencing_with_index(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
) -> Option<Georeferencing> {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());

    let mut entity_types: Vec<(u32, IfcType)> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, _start, _end)) = scanner.next_entity() {
        match type_name {
            "IFCMAPCONVERSION" => entity_types.push((id, IfcType::IfcMapConversion)),
            "IFCPROJECTEDCRS" => entity_types.push((id, IfcType::IfcProjectedCRS)),
            "IFCPROPERTYSET" => entity_types.push((id, IfcType::IfcPropertySet)),
            // Legacy IfcSite RefLatitude/RefLongitude fallback (TS parity).
            "IFCSITE" => entity_types.push((id, IfcType::IfcSite)),
            _ => {}
        }
    }

    if entity_types.is_empty() {
        return None;
    }

    match GeoRefExtractor::extract(&mut decoder, &entity_types) {
        Ok(Some(geo)) => Some(Georeferencing::from_core(&geo)),
        Ok(None) => None,
        Err(e) => {
            tracing::debug!(error = %e, "Georeferencing extraction failed");
            None
        }
    }
}

#[cfg(test)]
#[path = "georeferencing_tests.rs"]
mod tests;
