// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC Georeferencing Support
//!
//! Handles IfcMapConversion and IfcProjectedCRS for coordinate transformations.
//! Supports both IFC4 native entities and IFC2X3 ePSet_MapConversion fallback.

use crate::decoder::EntityDecoder;
use crate::error::Result;
use crate::generated::IfcType;
use crate::schema_gen::DecodedEntity;

/// Georeferencing information extracted from IFC model
#[derive(Debug, Clone)]
pub struct GeoReference {
    /// CRS name (e.g., "EPSG:32632")
    pub crs_name: Option<String>,
    /// Geodetic datum (e.g., "WGS84")
    pub geodetic_datum: Option<String>,
    /// Vertical datum (e.g., "NAVD88")
    pub vertical_datum: Option<String>,
    /// Map projection (e.g., "UTM Zone 32N")
    pub map_projection: Option<String>,
    /// False easting (X offset to map CRS)
    pub eastings: f64,
    /// False northing (Y offset to map CRS)
    pub northings: f64,
    /// Orthogonal height (Z offset)
    pub orthogonal_height: f64,
    /// X-axis abscissa (cos of rotation angle)
    pub x_axis_abscissa: f64,
    /// X-axis ordinate (sin of rotation angle)
    pub x_axis_ordinate: f64,
    /// Scale factor (default 1.0)
    pub scale: f64,
}

impl Default for GeoReference {
    fn default() -> Self {
        Self {
            crs_name: None,
            geodetic_datum: None,
            vertical_datum: None,
            map_projection: None,
            eastings: 0.0,
            northings: 0.0,
            orthogonal_height: 0.0,
            x_axis_abscissa: 1.0, // No rotation (cos(0) = 1)
            x_axis_ordinate: 0.0, // No rotation (sin(0) = 0)
            scale: 1.0,
        }
    }
}

impl GeoReference {
    /// Create new georeferencing info with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if georeferencing is present
    #[inline]
    pub fn has_georef(&self) -> bool {
        self.crs_name.is_some()
            || self.eastings != 0.0
            || self.northings != 0.0
            || self.orthogonal_height != 0.0
    }

    /// Get rotation angle in radians
    #[inline]
    pub fn rotation(&self) -> f64 {
        self.x_axis_ordinate.atan2(self.x_axis_abscissa)
    }

    /// Transform local coordinates to map coordinates
    #[inline]
    pub fn local_to_map(&self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        let e = s * (cos_r * x - sin_r * y) + self.eastings;
        let n = s * (sin_r * x + cos_r * y) + self.northings;
        let h = z + self.orthogonal_height;

        (e, n, h)
    }

    /// Transform map coordinates to local coordinates
    #[inline]
    pub fn map_to_local(&self, e: f64, n: f64, h: f64) -> (f64, f64, f64) {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        // Guard against division by zero
        let inv_scale = if self.scale.abs() < f64::EPSILON {
            1.0
        } else {
            1.0 / self.scale
        };

        let dx = e - self.eastings;
        let dy = n - self.northings;

        // Inverse rotation: transpose of rotation matrix
        let x = inv_scale * (cos_r * dx + sin_r * dy);
        let y = inv_scale * (-sin_r * dx + cos_r * dy);
        let z = h - self.orthogonal_height;

        (x, y, z)
    }

    /// Get 4x4 transformation matrix (column-major for OpenGL/WebGL)
    pub fn to_matrix(&self) -> [f64; 16] {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        // Column-major 4x4 matrix
        [
            s * cos_r,
            s * sin_r,
            0.0,
            0.0,
            -s * sin_r,
            s * cos_r,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            self.eastings,
            self.northings,
            self.orthogonal_height,
            1.0,
        ]
    }
}

/// Extract georeferencing from IFC content
pub struct GeoRefExtractor;

impl GeoRefExtractor {
    /// Extract georeferencing from decoder
    pub fn extract(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<GeoReference>> {
        // Find IfcMapConversion and IfcProjectedCRS entities
        let mut map_conversion_id: Option<u32> = None;
        let mut projected_crs_id: Option<u32> = None;

        for (id, ifc_type) in entity_types {
            match ifc_type {
                IfcType::IfcMapConversion => {
                    map_conversion_id = Some(*id);
                }
                IfcType::IfcProjectedCRS => {
                    projected_crs_id = Some(*id);
                }
                _ => {}
            }
        }

        // If no map conversion, try IFC2X3 property set fallback
        if map_conversion_id.is_none() {
            return Self::extract_from_pset(decoder, entity_types);
        }

        let mut georef = GeoReference::new();

        // Parse IfcMapConversion
        // Attributes: SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight,
        //             XAxisAbscissa, XAxisOrdinate, Scale
        if let Some(id) = map_conversion_id {
            let entity = decoder.decode_by_id(id)?;
            Self::parse_map_conversion(&entity, &mut georef);
        }

        // Parse IfcProjectedCRS
        // Attributes: Name, Description, GeodeticDatum, VerticalDatum,
        //             MapProjection, MapZone, MapUnit
        if let Some(id) = projected_crs_id {
            let entity = decoder.decode_by_id(id)?;
            Self::parse_projected_crs(&entity, &mut georef);
        }

        if georef.has_georef() {
            Ok(Some(georef))
        } else {
            Ok(None)
        }
    }

    /// Parse IfcMapConversion entity
    fn parse_map_conversion(entity: &DecodedEntity, georef: &mut GeoReference) {
        // Index 2: Eastings
        if let Some(e) = entity.get_float(2) {
            georef.eastings = e;
        }
        // Index 3: Northings
        if let Some(n) = entity.get_float(3) {
            georef.northings = n;
        }
        // Index 4: OrthogonalHeight
        if let Some(h) = entity.get_float(4) {
            georef.orthogonal_height = h;
        }
        // Index 5: XAxisAbscissa (optional)
        if let Some(xa) = entity.get_float(5) {
            georef.x_axis_abscissa = xa;
        }
        // Index 6: XAxisOrdinate (optional)
        if let Some(xo) = entity.get_float(6) {
            georef.x_axis_ordinate = xo;
        }
        // Index 7: Scale (optional, default 1.0)
        if let Some(s) = entity.get_float(7) {
            georef.scale = s;
        }
    }

    /// Parse IfcProjectedCRS entity
    fn parse_projected_crs(entity: &DecodedEntity, georef: &mut GeoReference) {
        // Index 0: Name (e.g., "EPSG:32632")
        if let Some(name) = entity.get_string(0) {
            georef.crs_name = Some(name.to_string());
        }
        // Index 2: GeodeticDatum
        if let Some(datum) = entity.get_string(2) {
            georef.geodetic_datum = Some(datum.to_string());
        }
        // Index 3: VerticalDatum
        if let Some(vdatum) = entity.get_string(3) {
            georef.vertical_datum = Some(vdatum.to_string());
        }
        // Index 4: MapProjection
        if let Some(proj) = entity.get_string(4) {
            georef.map_projection = Some(proj.to_string());
        }
    }

    /// Extract from IFC2X3 property sets (fallback)
    fn extract_from_pset(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<GeoReference>> {
        // Find IfcPropertySet with name ePSet_MapConversion
        for (id, ifc_type) in entity_types {
            if *ifc_type == IfcType::IfcPropertySet {
                let entity = decoder.decode_by_id(*id)?;
                // IfcPropertySet.Name is attribute 2 (attribute 0 is GlobalId);
                // reading attribute 0 here never matched the ePSet, so the
                // IFC2x3 georeferencing fallback was dead (issue #900 review).
                if let Some(name) = entity.get_string(2) {
                    if name == "ePSet_MapConversion" || name == "EPset_MapConversion" {
                        return Self::parse_pset_map_conversion(decoder, &entity);
                    }
                }
            }
        }
        Ok(None)
    }

    /// Parse ePSet_MapConversion property set
    fn parse_pset_map_conversion(
        decoder: &mut EntityDecoder,
        pset: &DecodedEntity,
    ) -> Result<Option<GeoReference>> {
        let mut georef = GeoReference::new();

        // HasProperties is typically at index 4
        if let Some(props_list) = pset.get_list(4) {
            for prop_attr in props_list {
                if let Some(prop_id) = prop_attr.as_entity_ref() {
                    let prop = decoder.decode_by_id(prop_id)?;
                    // IfcPropertySingleValue: Name (0), Description (1), NominalValue (2)
                    if let Some(name) = prop.get_string(0) {
                        let value = prop.get_float(2);
                        match name {
                            "Eastings" => {
                                if let Some(v) = value {
                                    georef.eastings = v;
                                }
                            }
                            "Northings" => {
                                if let Some(v) = value {
                                    georef.northings = v;
                                }
                            }
                            "OrthogonalHeight" => {
                                if let Some(v) = value {
                                    georef.orthogonal_height = v;
                                }
                            }
                            "XAxisAbscissa" => {
                                if let Some(v) = value {
                                    georef.x_axis_abscissa = v;
                                }
                            }
                            "XAxisOrdinate" => {
                                if let Some(v) = value {
                                    georef.x_axis_ordinate = v;
                                }
                            }
                            "Scale" => {
                                if let Some(v) = value {
                                    georef.scale = v;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        if georef.has_georef() {
            Ok(Some(georef))
        } else {
            Ok(None)
        }
    }
}

/// RTC (Relative-To-Center) coordinate handler for large coordinates
#[derive(Debug, Clone, Default)]
pub struct RtcOffset {
    /// Center offset (subtracted from all coordinates)
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl RtcOffset {
    /// Create from centroid of positions
    #[inline]
    pub fn from_positions(positions: &[f32]) -> Self {
        if positions.is_empty() {
            return Self::default();
        }

        let count = positions.len() / 3;
        let mut sum = (0.0f64, 0.0f64, 0.0f64);

        for chunk in positions.chunks_exact(3) {
            sum.0 += chunk[0] as f64;
            sum.1 += chunk[1] as f64;
            sum.2 += chunk[2] as f64;
        }

        Self {
            x: sum.0 / count as f64,
            y: sum.1 / count as f64,
            z: sum.2 / count as f64,
        }
    }

    /// Check if offset is significant (>10km from origin)
    #[inline]
    pub fn is_significant(&self) -> bool {
        const THRESHOLD: f64 = 10000.0; // 10km
        self.x.abs() > THRESHOLD || self.y.abs() > THRESHOLD || self.z.abs() > THRESHOLD
    }

    /// Apply offset to positions in-place
    #[inline]
    pub fn apply(&self, positions: &mut [f32]) {
        for chunk in positions.chunks_exact_mut(3) {
            chunk[0] = (chunk[0] as f64 - self.x) as f32;
            chunk[1] = (chunk[1] as f64 - self.y) as f32;
            chunk[2] = (chunk[2] as f64 - self.z) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_georef_local_to_map() {
        let mut georef = GeoReference::new();
        georef.eastings = 500000.0;
        georef.northings = 5000000.0;
        georef.orthogonal_height = 100.0;

        let (e, n, h) = georef.local_to_map(10.0, 20.0, 5.0);
        assert!((e - 500010.0).abs() < 1e-10);
        assert!((n - 5000020.0).abs() < 1e-10);
        assert!((h - 105.0).abs() < 1e-10);
    }

    #[test]
    fn test_georef_map_to_local() {
        let mut georef = GeoReference::new();
        georef.eastings = 500000.0;
        georef.northings = 5000000.0;
        georef.orthogonal_height = 100.0;

        let (x, y, z) = georef.map_to_local(500010.0, 5000020.0, 105.0);
        assert!((x - 10.0).abs() < 1e-10);
        assert!((y - 20.0).abs() < 1e-10);
        assert!((z - 5.0).abs() < 1e-10);
    }

    #[test]
    fn test_georef_with_rotation() {
        let mut georef = GeoReference::new();
        georef.eastings = 0.0;
        georef.northings = 0.0;
        // 90 degree rotation
        georef.x_axis_abscissa = 0.0;
        georef.x_axis_ordinate = 1.0;

        let (e, n, _) = georef.local_to_map(10.0, 0.0, 0.0);
        // After 90 degree rotation: (10, 0) -> (0, 10)
        assert!(e.abs() < 1e-10);
        assert!((n - 10.0).abs() < 1e-10);
    }

    #[test]
    fn test_rtc_offset() {
        let positions = vec![
            500000.0f32,
            5000000.0,
            0.0,
            500010.0,
            5000010.0,
            10.0,
            500020.0,
            5000020.0,
            20.0,
        ];

        let offset = RtcOffset::from_positions(&positions);
        assert!(offset.is_significant());
        assert!((offset.x - 500010.0).abs() < 1.0);
        assert!((offset.y - 5000010.0).abs() < 1.0);
    }

    #[test]
    fn test_rtc_apply() {
        let mut positions = vec![500000.0f32, 5000000.0, 0.0, 500010.0, 5000010.0, 10.0];

        let offset = RtcOffset {
            x: 500000.0,
            y: 5000000.0,
            z: 0.0,
        };

        offset.apply(&mut positions);

        assert!((positions[0] - 0.0).abs() < 1e-5);
        assert!((positions[1] - 0.0).abs() < 1e-5);
        assert!((positions[3] - 10.0).abs() < 1e-5);
        assert!((positions[4] - 10.0).abs() < 1e-5);
    }
}
