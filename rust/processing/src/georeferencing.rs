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

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, GeoRefExtractor, IfcType};
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
pub fn extract_georeferencing(content: &str) -> Option<Georeferencing> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

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
mod tests {
    use super::*;

    const GEOREF_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('georef fixture'),'2;1');
FILE_NAME('georef.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCPROJECTEDCRS('EPSG:32632','WGS84 / UTM zone 32N','WGS84',$,'UTM','32N',$);
#11=IFCMAPCONVERSION(#2,#10,1000.5,2000.25,42.0,0.866025,0.5,1.0);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn extracts_map_conversion_and_crs() {
        let geo = extract_georeferencing(GEOREF_IFC).expect("expected georeferencing");
        assert_eq!(geo.crs_name.as_deref(), Some("EPSG:32632"));
        assert_eq!(geo.geodetic_datum.as_deref(), Some("WGS84"));
        assert_eq!(geo.map_projection.as_deref(), Some("UTM"));
        assert!((geo.eastings - 1000.5).abs() < 1e-6);
        assert!((geo.northings - 2000.25).abs() < 1e-6);
        assert!((geo.orthogonal_height - 42.0).abs() < 1e-6);
        // XAxisAbscissa/Ordinate = cos/sin(30°) → rotation_degrees ≈ 30.
        assert!(
            (geo.rotation_degrees - 30.0).abs() < 1e-3,
            "rotation should be ~30°, got {}",
            geo.rotation_degrees
        );
        // Translation column of the local→map matrix carries the offsets.
        assert!((geo.transform_matrix[12] - 1000.5).abs() < 1e-6);
        assert!((geo.transform_matrix[13] - 2000.25).abs() < 1e-6);
        // New parity fields (alignment audit): description/zone + provenance.
        assert_eq!(geo.crs_description.as_deref(), Some("WGS84 / UTM zone 32N"));
        assert_eq!(geo.map_zone.as_deref(), Some("32N"));
        // No MapUnit authored → project length unit applies (both None).
        assert_eq!(geo.map_unit, None);
        assert_eq!(geo.map_unit_scale, None);
        assert_eq!(geo.source.as_deref(), Some("mapConversion"));
    }

    /// IFC2x3 models carry georeferencing via an `ePSet_MapConversion` property
    /// set rather than `IfcMapConversion`. Regression for the core extractor bug
    /// that read `IfcPropertySet.Name` from attribute 0 (GlobalId) instead of 2.
    const IFC2X3_PSET_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ifc2x3 georef pset fixture'),'2;1');
FILE_NAME('georef2x3.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(1000.5),$);
#2=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(2000.25),$);
#3=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(42.),$);
#4=IFCPROPERTYSET('0PSet00000000000000001',$,'ePSet_MapConversion',$,(#1,#2,#3));
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn extracts_ifc2x3_epset_map_conversion_fallback() {
        let geo = extract_georeferencing(IFC2X3_PSET_IFC)
            .expect("expected georeferencing from ePSet_MapConversion");
        assert!((geo.eastings - 1000.5).abs() < 1e-6);
        assert!((geo.northings - 2000.25).abs() < 1e-6);
        assert!((geo.orthogonal_height - 42.0).abs() < 1e-6);
    }

    /// Millimetre MapUnit: the conversion offsets are authored in mm and the
    /// served `map_unit_scale` must say 0.001 — the TS parser already did
    /// this; the server previously ignored MapUnit entirely (alignment
    /// audit). Values mirror packages/parser/test/georef-extractor.test.ts.
    const MM_MAPUNIT_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('georef mm fixture'),'2;1');
FILE_NAME('georef-mm.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCPROJECTEDCRS('EPSG:25832',$,'ETRS89',$,'UTM','32N',#7);
#11=IFCMAPCONVERSION(#2,#10,512000000.,5400000000.,0.,1.,0.,1.0);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn resolves_millimetre_map_unit_scale() {
        let geo = extract_georeferencing(MM_MAPUNIT_IFC).expect("georef");
        assert_eq!(geo.map_unit.as_deref(), Some("MILLIMETRE"));
        assert_eq!(geo.map_unit_scale, Some(0.001));
        assert_eq!(geo.map_zone.as_deref(), Some("32N"));
    }

    /// Two authored IfcMapConversions: the FIRST one wins, matching the TS
    /// parser's `mapConversionIds[0]` pick (the server used to serve the
    /// LAST one — alignment audit).
    const TWO_CONVERSIONS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('georef two-conversions fixture'),'2;1');
FILE_NAME('georef-two.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#10=IFCPROJECTEDCRS('EPSG:32632',$,'WGS84',$,'UTM','32N',$);
#11=IFCMAPCONVERSION(#2,#10,111.0,222.0,0.,1.,0.,1.0);
#12=IFCMAPCONVERSION(#2,#10,999.0,888.0,0.,1.,0.,1.0);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn first_map_conversion_wins() {
        let geo = extract_georeferencing(TWO_CONVERSIONS_IFC).expect("georef");
        assert!((geo.eastings - 111.0).abs() < 1e-9);
        assert!((geo.northings - 222.0).abs() < 1e-9);
    }

    /// Non-unit XAxisAbscissa/Ordinate (a DIRECTION, not cos/sin): the
    /// rotation and the transform matrix must agree with each other and
    /// with the TS parser's atan2-normalised matrix. Pre-fix, the matrix
    /// used the raw components as cos/sin and disagreed with
    /// `rotation_degrees` inside the same payload (alignment audit).
    const NON_UNIT_AXIS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('georef non-unit-axis fixture'),'2;1');
FILE_NAME('georef-axis.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#10=IFCPROJECTEDCRS('EPSG:32632',$,'WGS84',$,'UTM','32N',$);
#11=IFCMAPCONVERSION(#2,#10,1000.,2000.,0.,3.0,4.0,1.0);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn non_unit_axis_is_normalised() {
        let geo = extract_georeferencing(NON_UNIT_AXIS_IFC).expect("georef");
        // (3,4) direction → unit (0.6, 0.8); rotation ≈ 53.130°.
        assert!((geo.x_axis_abscissa - 0.6).abs() < 1e-9);
        assert!((geo.x_axis_ordinate - 0.8).abs() < 1e-9);
        assert!((geo.rotation_degrees - 53.13010235415598).abs() < 1e-9);
        // Matrix rotation cell == cos(rotation) — self-consistent payload.
        assert!((geo.transform_matrix[0] - 0.6).abs() < 1e-9);
        assert!((geo.transform_matrix[1] - 0.8).abs() < 1e-9);
    }

    /// Site-only model: `IfcSite.RefLatitude/RefLongitude` must produce a
    /// georeference exactly like the TS parser's legacy-site fallback —
    /// previously the server reported NO georeferencing for these models
    /// while the browser said `hasGeoreference: true` (alignment audit).
    /// Mirrors the values in packages/parser/test/georef-extractor.test.ts.
    const SITE_ONLY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('georef site-only fixture'),'2;1');
FILE_NAME('georef-site.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#10=IFCSITE('0Site0000000000000001',$,'Site',$,$,#11,$,$,.ELEMENT.,(47,22,30,0),(8,32,15,0),420.5,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn site_lat_long_fallback_matches_ts_parser() {
        let geo = extract_georeferencing(SITE_ONLY_IFC).expect("site georef");
        assert_eq!(geo.source.as_deref(), Some("siteLocation"));
        assert_eq!(geo.crs_name.as_deref(), Some("EPSG:4326"));
        assert_eq!(geo.geodetic_datum.as_deref(), Some("WGS84"));
        assert_eq!(geo.map_unit.as_deref(), Some("DEGREE"));
        // 47°22'30" → 47.375; 8°32'15" → 8.5375 (longitude in eastings,
        // latitude in northings — same packing as the TS fallback).
        assert!((geo.northings - 47.375).abs() < 1e-9, "lat {}", geo.northings);
        assert!((geo.eastings - 8.5375).abs() < 1e-9, "long {}", geo.eastings);
        assert!((geo.orthogonal_height - 420.5).abs() < 1e-9);
    }

    #[test]
    fn returns_none_without_georeferencing() {
        let plain = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
        assert!(extract_georeferencing(plain).is_none());
    }
}
