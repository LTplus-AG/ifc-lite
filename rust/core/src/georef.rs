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
use crate::slot;

#[path = "georef_parse.rs"]
mod georef_parse;
use georef_parse::{compound_angle_has_literal_negative_zero, compound_plane_angle_to_degrees};

#[path = "georef_pset.rs"]
mod georef_pset;

#[path = "georef_operation.rs"]
mod georef_operation;
use georef_operation::{
    parse_geographic_crs, parse_rigid_operation, plane_angle_unit_to_degrees,
    project_plane_angle_unit_to_degrees, well_known_text_for, RigidTarget,
};

#[path = "georef_details.rs"]
mod georef_details;
pub use georef_details::{CoordinateOperationKind, GeoReferenceDetails};

/// Where the georeferencing data was authored in the file.
///
/// Single discriminator shared (string-for-string) with the TS parser's
/// `GeoreferenceInfo.source`, so server consumers and browser consumers see
/// the same provenance for the same model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeoRefSource {
    /// IFC4 `IfcMapConversion` (+ optional `IfcProjectedCRS`).
    MapConversion,
    /// IFC2x3 `ePSet_MapConversion` property-set fallback.
    EPSetMapConversion,
    /// Legacy `IfcSite.RefLatitude`/`RefLongitude` (WGS84 degrees).
    SiteLocation,
}

impl GeoRefSource {
    /// Stable wire label (matches the TS parser's `source` union).
    pub fn label(self) -> &'static str {
        match self {
            Self::MapConversion => "mapConversion",
            Self::EPSetMapConversion => "ePSetMapConversion",
            Self::SiteLocation => "siteLocation",
        }
    }
}

/// Georeferencing information extracted from IFC model
#[derive(Debug, Clone)]
pub struct GeoReference {
    /// CRS name (e.g., "EPSG:32632")
    pub crs_name: Option<String>,
    /// CRS description from `IfcProjectedCRS.Description`.
    pub crs_description: Option<String>,
    /// Geodetic datum (e.g., "WGS84")
    pub geodetic_datum: Option<String>,
    /// Vertical datum (e.g., "NAVD88")
    pub vertical_datum: Option<String>,
    /// Map projection (e.g., "UTM Zone 32N")
    pub map_projection: Option<String>,
    /// Map zone (e.g., "32N") from `IfcProjectedCRS.MapZone`.
    pub map_zone: Option<String>,
    /// Map unit name resolved from `IfcProjectedCRS.MapUnit`
    /// (e.g. "METRE", "MILLIMETRE"). `None` when no MapUnit is authored —
    /// per spec the project length unit then applies.
    pub map_unit: Option<String>,
    /// Scale factor converting MapConversion values to metres, derived from
    /// `MapUnit` (0.001 for millimetres). `None` when no MapUnit is authored.
    pub map_unit_scale: Option<f64>,
    /// Where the data was authored (`IfcMapConversion`, ePSet fallback, or
    /// legacy `IfcSite` lat/long). `None` when only a named
    /// `IfcProjectedCRS` was found: no conversion was authored, or the one
    /// authored was refused, so nothing placed the model. The TS twin leaves
    /// `source` unset in the same case.
    pub source: Option<GeoRefSource>,
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
    /// Per-axis factors from `IfcMapConversionScaled.FactorX/Y/Z` (IFC4X3),
    /// each 1.0 when absent. Per the schema they scale coordinates, not
    /// units (`scale` converts units): each multiplies its own local axis
    /// before the rotation, on top of `scale`. Ignoring them applied a
    /// conversion authored with factors of 0.3048 at 3.28x.
    pub factor_x: f64,
    pub factor_y: f64,
    pub factor_z: f64,
    /// True once an `IfcMapConversion` (or its `Scaled` subtype) was parsed.
    /// Presence is then reported even for a conversion whose translations are
    /// all zero (a rotation- or scale-only conversion), matching the TS
    /// twin, which sets `hasGeoreference` whenever a conversion parsed.
    pub has_map_conversion: bool,
}

impl Default for GeoReference {
    fn default() -> Self {
        Self {
            crs_name: None,
            crs_description: None,
            geodetic_datum: None,
            vertical_datum: None,
            map_projection: None,
            map_zone: None,
            map_unit: None,
            map_unit_scale: None,
            source: None,
            eastings: 0.0,
            northings: 0.0,
            orthogonal_height: 0.0,
            x_axis_abscissa: 1.0, // No rotation (cos(0) = 1)
            x_axis_ordinate: 0.0, // No rotation (sin(0) = 0)
            scale: 1.0,
            factor_x: 1.0,
            factor_y: 1.0,
            factor_z: 1.0,
            has_map_conversion: false,
        }
    }
}

impl GeoReference {
    /// Create new georeferencing info with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if georeferencing is present.
    ///
    /// A parsed `IfcMapConversion` is presence on its own: the value test
    /// alone dropped a rotation-only conversion (zero offsets, 30 degrees to
    /// grid north) as "no georeferencing" while the browser reported one.
    /// A parsed `IfcRigidOperation` uses the same placement source, even
    /// when its translation is zero. WKT-only presence is carried separately
    /// by [`GeoReferenceDetails`].
    #[inline]
    pub fn has_georef(&self) -> bool {
        self.has_map_conversion
            || self.source == Some(GeoRefSource::MapConversion)
            || self.crs_name.is_some()
            || self.eastings != 0.0
            || self.northings != 0.0
            || self.orthogonal_height != 0.0
    }

    /// Get rotation angle in radians
    #[inline]
    pub fn rotation(&self) -> f64 {
        self.x_axis_ordinate.atan2(self.x_axis_abscissa)
    }

    /// Normalize the X-axis direction to a unit vector, and refuse the
    /// transform components that have no usable value.
    ///
    /// `IfcMapConversion.XAxisAbscissa/Ordinate` form a DIRECTION — files may
    /// author non-unit components. `local_to_map`/`to_matrix` use them
    /// directly as cos/sin, so without normalization those disagreed with
    /// [`rotation`](Self::rotation) (which `atan2`-normalizes) within one
    /// payload, and with the TS parser's matrix (alignment audit). Called at
    /// parse time by every extraction path.
    ///
    /// A direction with no usable length (both components authored `0.`, or
    /// two finite components whose `hypot` overflows) is reset to
    /// the identity `(1, 0)`, the angle the TS twin's `atan2(0, 0)` gives.
    /// Passed through, `(0, 0)` collapsed every map coordinate to
    /// `(Eastings, Northings)` and an infinite length divided into NaN. An
    /// `IfcMapConversion` or ePSet with a non-finite placement component never
    /// gets here: both extractors refuse the placement whole (#7678).
    ///
    /// `Scale` and `FactorX/Y/Z` follow the same rule: zero collapses every
    /// coordinate onto the translation and a non-finite value poisons it, so
    /// either resets to 1.0 (the TS twin reads a zero `Scale` as 1.0 through
    /// `scale || 1.0`).
    fn sanitize_transform(&mut self) {
        let len = self.x_axis_abscissa.hypot(self.x_axis_ordinate);
        if !(len.is_finite() && len > f64::EPSILON) {
            self.x_axis_abscissa = 1.0;
            self.x_axis_ordinate = 0.0;
        } else if (len - 1.0).abs() > f64::EPSILON {
            self.x_axis_abscissa /= len;
            self.x_axis_ordinate /= len;
        }
        for s in [&mut self.scale, &mut self.factor_x, &mut self.factor_y, &mut self.factor_z] {
            if !(s.is_finite() && *s != 0.0) {
                *s = 1.0;
            }
        }
    }

    /// Effective per-axis scale: the uniform `Scale` times the
    /// `IfcMapConversionScaled` factor for that axis.
    #[inline]
    fn axis_scales(&self) -> (f64, f64, f64) {
        (
            self.scale * self.factor_x,
            self.scale * self.factor_y,
            self.scale * self.factor_z,
        )
    }

    /// Transform local coordinates to map coordinates
    ///
    /// Per IFC4x3 `IfcMapConversion`: "a scaling of the three axes (x,y,z),
    /// by the same Scale, followed by an anti-clockwise rotation about the
    /// z-axis [...] and then a translation in (x,y,z) of Eastings,
    /// Northings, OrthogonalHeight" — note the Scale applies to z as well
    /// ("one scale is applied equally to x, y and z, to convert units").
    /// `IfcMapConversionScaled` adds a per-axis factor on top of that.
    #[inline]
    pub fn local_to_map(&self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let (sx, sy, sz) = self.axis_scales();
        let (x, y, z) = (sx * x, sy * y, sz * z);

        let e = cos_r * x - sin_r * y + self.eastings;
        let n = sin_r * x + cos_r * y + self.northings;
        let h = z + self.orthogonal_height;

        (e, n, h)
    }

    /// Transform map coordinates to local coordinates
    #[inline]
    pub fn map_to_local(&self, e: f64, n: f64, h: f64) -> (f64, f64, f64) {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        // Guard against division by zero, per axis.
        let inv = |s: f64| if s.abs() < f64::EPSILON { 1.0 } else { 1.0 / s };
        let (sx, sy, sz) = self.axis_scales();

        let dx = e - self.eastings;
        let dy = n - self.northings;

        // Inverse rotation (transpose), then undo the per-axis scale.
        let x = inv(sx) * (cos_r * dx + sin_r * dy);
        let y = inv(sy) * (-sin_r * dx + cos_r * dy);
        // Scale applies to z too (IfcMapConversion scales all three axes).
        let z = inv(sz) * (h - self.orthogonal_height);

        (x, y, z)
    }

    /// Get 4x4 transformation matrix (column-major for OpenGL/WebGL)
    pub fn to_matrix(&self) -> [f64; 16] {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let (sx, sy, sz) = self.axis_scales();

        // Column-major 4x4 matrix: scale each local axis, then rotate.
        [
            sx * cos_r,
            sx * sin_r,
            0.0,
            0.0,
            -sy * sin_r,
            sy * cos_r,
            0.0,
            0.0,
            0.0,
            0.0,
            // Scale applies to z as well (IfcMapConversion scales all three axes).
            sz,
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

/// Resolve an `IfcConversionBasedUnit`'s `ConversionFactor` to metres.
///
/// `IFCMEASUREWITHUNIT: [0] ValueComponent, [1] UnitComponent` — the value is
/// expressed IN the unit component, so a prefixed SI component multiplies it
/// (0.3048 expressed in millimetres is not 0.3048 metres). Twin of
/// `resolveMeasureWithUnit` in packages/parser/src/georef-extractor.ts.
fn resolve_measure_with_unit(
    decoder: &mut EntityDecoder,
    conversion_unit: &DecodedEntity,
) -> Option<f64> {
    let measure_ref = conversion_unit.ref_at(slot::IfcConversionBasedUnit::CONVERSION_FACTOR)?;
    let measure = decoder.decode_by_id(measure_ref).ok()?;

    let value_attr = measure.attr(slot::IfcMeasureWithUnit::VALUE_COMPONENT)?;
    let value = value_attr
        .as_float()
        .or_else(|| value_attr.as_int().map(|v| v as f64))?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }

    let mut component_scale = 1.0_f64;
    if let Some(component_ref) = measure.ref_at(slot::IfcMeasureWithUnit::UNIT_COMPONENT) {
        if let Ok(component) = decoder.decode_by_id(component_ref) {
            if component.ifc_type == IfcType::IfcSIUnit {
                if let Some(prefix_attr) = component.attr(slot::IfcSIUnit::PREFIX) {
                    if !prefix_attr.is_null() {
                        if let Some(prefix) = prefix_attr.as_enum() {
                            component_scale = crate::units::get_si_prefix_multiplier(prefix);
                        }
                    }
                }
            }
        }
    }

    Some(value * component_scale)
}

/// The first candidate of each georeferencing entity kind, in file order.
#[derive(Default)]
struct GeoRefCandidates {
    map_conversion: Option<u32>,
    rigid_operation: Option<u32>,
    projected_crs: Option<u32>,
    geographic_crs: Option<u32>,
    project: Option<u32>,
    well_known_texts: Vec<u32>,
}

impl GeoRefCandidates {
    fn collect(entity_types: &[(u32, IfcType)]) -> Self {
        let mut out = Self::default();
        for (id, ifc_type) in entity_types {
            let id = *id;
            let first = match ifc_type {
                // The Scaled subtype by its own type too: only the processing
                // scan relabels it as the supertype, and a caller typing it
                // with `IfcType::from_str` lost the whole conversion.
                IfcType::IfcMapConversion | IfcType::IfcMapConversionScaled => &mut out.map_conversion,
                IfcType::IfcRigidOperation => &mut out.rigid_operation,
                IfcType::IfcProjectedCRS => &mut out.projected_crs,
                IfcType::IfcGeographicCRS => &mut out.geographic_crs,
                IfcType::IfcProject => &mut out.project,
                IfcType::IfcWellKnownText => {
                    out.well_known_texts.push(id);
                    continue;
                }
                _ => continue,
            };
            first.get_or_insert(id);
        }
        out
    }
}

fn is_crs(entity: &DecodedEntity) -> bool {
    matches!(entity.ifc_type, IfcType::IfcProjectedCRS | IfcType::IfcGeographicCRS)
}

impl GeoRefExtractor {
    /// Extract georeferencing from decoder
    ///
    /// Precedence (identical to the TS parser): `IfcMapConversion` (else the
    /// IFC4X3 `IfcRigidOperation`) or a CRS with a non-blank Name or an
    /// `IfcWellKnownText` definition → `ePSet_MapConversion` (IFC2x3) →
    /// legacy `IfcSite` lat/long. A refused operation counts as no
    /// operation, and a CRS with neither Name nor WKT declares none, so
    /// neither holds back the fallbacks on its own.
    ///
    /// The CRS read is the operation's own TargetCRS when it is an
    /// `IfcProjectedCRS` or `IfcGeographicCRS`, else the first
    /// `IfcProjectedCRS`, else the first `IfcGeographicCRS`.
    pub fn extract(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<GeoReference>> {
        Self::extract_with_details(decoder, entity_types)
            .map(|result| result.map(|(georef, _)| georef))
    }

    /// Extract placement together with coordinate-operation provenance and WKT.
    ///
    /// Rigid operations use [`GeoRefSource::MapConversion`] in the compatible
    /// placement record, while `details.operation` identifies their actual kind.
    /// A CRS defined only by `IfcWellKnownText` (no Name) declares itself
    /// through a parsed coordinate operation: on its own it places nothing,
    /// and the fallbacks run, as they did before IFC4X3 WKT support.
    pub fn extract_with_details(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<(GeoReference, GeoReferenceDetails)>> {
        // FIRST of each kind wins (same pick as the TS parser, which reads
        // `mapConversionIds[0]`) — last-wins silently flipped the served
        // conversion on files with several authored conversions (alignment
        // audit).
        let candidates = GeoRefCandidates::collect(entity_types);
        let mut georef = GeoReference::new();
        let mut details = GeoReferenceDetails::default();

        // Parse IfcMapConversion
        // Attributes: SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight,
        //             XAxisAbscissa, XAxisOrdinate, Scale
        // Lossless (#7678): an overflowing component must reach the
        // whole-conversion refusal in `parse_map_conversion`, not refuse the
        // record and with it the CRS fallbacks below.
        let mut operation = None;
        if let Some(id) = candidates.map_conversion {
            let conversion = decoder.decode_by_id_lossless(id)?;
            Self::parse_map_conversion(&conversion, &mut georef);
            operation = georef.has_map_conversion.then_some(conversion);
            details.operation = georef.has_map_conversion.then_some(CoordinateOperationKind::MapConversion);
        }
        // IFC4X3 IfcRigidOperation, when no map conversion was read. Its
        // plane-angle form needs the geographic target's angle unit, so the
        // target CRS is resolved before the operation is read.
        let rigid = match (&operation, candidates.rigid_operation) {
            (None, Some(id)) => decoder.decode_by_id_lossless(id).ok(),
            _ => None,
        };
        if rigid.is_some() {
            operation = rigid.clone();
        }

        let crs = Self::resolve_crs(decoder, operation.as_ref(), &candidates);
        let crs = match crs {
            Ok(crs) => crs,
            // Beside a parsed conversion the CRS's MapUnit scales every
            // coordinate, so an undecodable one stays an error. On its own
            // it declares nothing and the fallbacks still run.
            Err(error) if georef.has_map_conversion => return Err(error),
            Err(_) => None,
        };
        if let Some(entity) = &crs {
            if entity.ifc_type == IfcType::IfcGeographicCRS {
                parse_geographic_crs(entity, &mut georef);
            } else {
                Self::parse_projected_crs(entity, decoder, &mut georef);
            }
            details.well_known_text = well_known_text_for(decoder, entity.id, &candidates.well_known_texts);
        }

        if let Some(rigid) = &rigid {
            let target = Self::rigid_target(decoder, crs.as_ref(), candidates.project);
            if parse_rigid_operation(rigid, &target, &mut georef) {
                details.operation = Some(CoordinateOperationKind::RigidOperation);
            }
        }

        // Neither a parsed operation nor a declared CRS: try the IFC2X3
        // property set fallback, then the legacy IfcSite lat/long fallback
        // (TS parity, #4695). A refused operation left `georef` untouched, so
        // it counts as no operation here.
        if !georef.has_georef() {
            if let Some(georef) = Self::extract_from_pset(decoder, entity_types)? {
                return Ok(Some((georef, details)));
            }
            return Self::extract_from_site(decoder, entity_types)
                .map(|result| result.map(|georef| (georef, details)));
        }

        georef.sanitize_transform();
        Ok(Some((georef, details)))
    }

    /// The operation's TargetCRS when it is a CRS this reader understands,
    /// else the first `IfcProjectedCRS`, else the first `IfcGeographicCRS`.
    /// An undecodable TargetCRS falls through to the candidates.
    fn resolve_crs(
        decoder: &mut EntityDecoder,
        operation: Option<&DecodedEntity>,
        candidates: &GeoRefCandidates,
    ) -> Result<Option<DecodedEntity>> {
        let target = operation
            .and_then(|op| op.ref_at(slot::IfcCoordinateOperation::TARGET_CRS))
            .and_then(|id| decoder.decode_by_id(id).ok())
            .filter(is_crs);
        if target.is_some() {
            return Ok(target);
        }
        match candidates.projected_crs.or(candidates.geographic_crs) {
            Some(id) => decoder.decode_by_id(id).map(Some),
            None => Ok(None),
        }
    }

    /// What a rigid operation is read against: a geographic target and its
    /// angle unit (`AngleUnit`, else the project's plane-angle unit when no
    /// AngleUnit is authored, else radians).
    fn rigid_target(
        decoder: &mut EntityDecoder,
        crs: Option<&DecodedEntity>,
        project: Option<u32>,
    ) -> RigidTarget {
        let Some(crs) = crs.filter(|crs| crs.ifc_type == IfcType::IfcGeographicCRS) else {
            return RigidTarget { geographic: false, angle_unit_to_degrees: None };
        };
        let angle_unit_to_degrees = match crs.ref_at(slot::IfcGeographicCRS::ANGLE_UNIT) {
            Some(unit) => plane_angle_unit_to_degrees(decoder, unit),
            None => project_plane_angle_unit_to_degrees(decoder, project),
        };
        RigidTarget { geographic: true, angle_unit_to_degrees }
    }

    /// Parse IfcMapConversion entity (and the IFC4X3 `IfcMapConversionScaled`
    /// subtype, whose first eight attributes have the same layout).
    ///
    /// Leaves `georef` untouched when Eastings through Scale (attributes
    /// 2..=7) hold a number the double range cannot represent: the whole
    /// conversion is refused rather than one component replaced by its
    /// default, the rule the TS twin (`extractMapConversion`) applies.
    fn parse_map_conversion(entity: &DecodedEntity, georef: &mut GeoReference) {
        if (2..=10).any(|index| entity.get_float(index).is_some_and(|v| !v.is_finite())) {
            return;
        }
        georef.has_map_conversion = true;
        georef.source = Some(GeoRefSource::MapConversion);
        // Index 2: Eastings
        if let Some(e) = entity.real_at(slot::IfcMapConversion::EASTINGS) {
            georef.eastings = e;
        }
        // Index 3: Northings
        if let Some(n) = entity.real_at(slot::IfcMapConversion::NORTHINGS) {
            georef.northings = n;
        }
        // Index 4: OrthogonalHeight
        if let Some(h) = entity.real_at(slot::IfcMapConversion::ORTHOGONAL_HEIGHT) {
            georef.orthogonal_height = h;
        }
        // Index 5: XAxisAbscissa (optional)
        if let Some(xa) = entity.real_at(slot::IfcMapConversion::X_AXIS_ABSCISSA) {
            georef.x_axis_abscissa = xa;
        }
        // Index 6: XAxisOrdinate (optional)
        if let Some(xo) = entity.real_at(slot::IfcMapConversion::X_AXIS_ORDINATE) {
            georef.x_axis_ordinate = xo;
        }
        // Index 7: Scale (optional, default 1.0)
        if let Some(s) = entity.real_at(slot::IfcMapConversion::SCALE) {
            georef.scale = s;
        }
        // Index 8..10: IfcMapConversionScaled.FactorX/Y/Z (absent on the
        // plain supertype). These are the only reason the subtype exists;
        // reading it "as its supertype" silently applied a feet-based scaled
        // conversion unscaled. `sanitize_transform` refuses a zero or
        // non-finite factor.
        for (index, factor) in [
            (8, &mut georef.factor_x),
            (9, &mut georef.factor_y),
            (10, &mut georef.factor_z),
        ] {
            if let Some(f) = entity.get_float(index) {
                *factor = f;
            }
        }
    }

    /// Parse IfcProjectedCRS entity
    fn parse_projected_crs(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        georef: &mut GeoReference,
    ) {
        // Index 0: Name (e.g., "EPSG:32632"). Blank reads as unset, the rule
        // the ePSet path applies: the viewer gates on a non-empty CRS name,
        // so `Some("")` would claim a georeference nothing downstream shows.
        if let Some(name) = entity.string_at(slot::IfcProjectedCRS::NAME).filter(|name| !name.trim().is_empty()) {
            georef.crs_name = Some(name.to_string());
        }
        // Index 1: Description
        if let Some(desc) = entity.string_at(slot::IfcProjectedCRS::DESCRIPTION) {
            georef.crs_description = Some(desc.to_string());
        }
        // Index 2: GeodeticDatum
        if let Some(datum) = entity.string_at(slot::IfcProjectedCRS::GEODETIC_DATUM) {
            georef.geodetic_datum = Some(datum.to_string());
        }
        // Index 3: VerticalDatum
        if let Some(vdatum) = entity.string_at(slot::IfcProjectedCRS::VERTICAL_DATUM) {
            georef.vertical_datum = Some(vdatum.to_string());
        }
        // Index 4: MapProjection
        if let Some(proj) = entity.string_at(slot::IfcProjectedCRS::MAP_PROJECTION) {
            georef.map_projection = Some(proj.to_string());
        }
        // Index 5: MapZone
        if let Some(zone) = entity.string_at(slot::IfcProjectedCRS::MAP_ZONE) {
            georef.map_zone = Some(zone.to_string());
        }
        // Index 6: MapUnit (IfcNamedUnit ref). Mirrors the TS parser
        // (packages/parser/src/georef-extractor.ts): when a MapUnit IS
        // authored, default to METRE/1.0 and refine from the unit entity — a
        // millimetre-based or foot-based conversion must scale the same way on
        // the server as in the browser. When absent, the project length unit
        // applies (spec default) and both stay `None`.
        //
        // IfcNamedUnit is IfcSIUnit OR IfcConversionBasedUnit, and attribute 2
        // means something different in each: `Prefix` on the first, `Name` on
        // the second. Reading slot 2 as a prefix unconditionally meant a
        // foot-based MapUnit — the exact form ifc-lite's own exporter writes
        // (packages/export/src/step-georeferencing.ts) — matched no prefix and
        // fell through to METRE at scale 1, a silent 3.28x error on every
        // coordinate.
        if let Some(unit_ref) = entity.ref_at(slot::IfcProjectedCRS::MAP_UNIT) {
            let mut unit_name = "METRE".to_string();
            let mut unit_scale = 1.0_f64;
            if let Ok(unit_entity) = decoder.decode_by_id(unit_ref) {
                match unit_entity.ifc_type {
                    IfcType::IfcSIUnit => {
                        // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
                        if let Some(prefix_attr) = unit_entity.attr(slot::IfcSIUnit::PREFIX) {
                            if !prefix_attr.is_null() {
                                if let Some(prefix) = prefix_attr.as_enum() {
                                    let multiplier =
                                        crate::units::get_si_prefix_multiplier(prefix);
                                    if (multiplier - 1.0).abs() > f64::EPSILON {
                                        unit_scale = multiplier;
                                        let prefix_upper = prefix.to_ascii_uppercase();
                                        unit_name = if prefix_upper == "MILLI" {
                                            "MILLIMETRE".to_string()
                                        } else {
                                            format!("{prefix_upper}METRE")
                                        };
                                    }
                                }
                            }
                        }
                    }
                    IfcType::IfcConversionBasedUnit => {
                        // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType,
                        // [2] Name, [3] ConversionFactor (IfcMeasureWithUnit)
                        let name = unit_entity
                            .string_at(slot::IfcConversionBasedUnit::NAME)
                            .map(|n| n.trim_matches('\'').trim().to_ascii_uppercase());
                        // The name table first (it carries the exact defined
                        // ratios of FOOT, INCH, YARD and MILE; the US survey
                        // foot is NOT in it, so a conversion-based 'US SURVEY
                        // FOOT' reads its authored factor, CORE-27), then the
                        // file's own declared factor for an unknown name.
                        let scale = name
                            .as_deref()
                            .and_then(crate::units::get_conversion_based_unit_factor)
                            .or_else(|| {
                                resolve_measure_with_unit(decoder, &unit_entity)
                            });
                        if let Some(scale) = scale {
                            if scale.is_finite() && scale > 0.0 {
                                unit_scale = scale;
                                if let Some(name) = name {
                                    unit_name = name;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            georef.map_unit = Some(unit_name);
            georef.map_unit_scale = Some(unit_scale);
        }
    }

    /// Legacy `IfcSite.RefLatitude`/`RefLongitude` fallback (TS parity).
    ///
    /// Mirrors the TS parser's `extractLegacySiteGeoreference`: WGS84
    /// degrees land in eastings (longitude) / northings (latitude) with the
    /// site `RefElevation` as orthogonal height, under an `EPSG:4326`
    /// pseudo-CRS — so `hasGeoreference`/`has_georef` agree between the
    /// browser and the server for site-only models.
    fn extract_from_site(
        decoder: &mut EntityDecoder,
        entity_types: &[(u32, IfcType)],
    ) -> Result<Option<GeoReference>> {
        for (id, ifc_type) in entity_types {
            if *ifc_type != IfcType::IfcSite {
                continue;
            }
            let site = decoder.decode_by_id(*id)?;
            // IfcSite: RefLatitude (9), RefLongitude (10), RefElevation (11).
            let latitude = compound_plane_angle_to_degrees(&site, slot::IfcSite::REF_LATITUDE.index());
            let longitude = compound_plane_angle_to_degrees(&site, slot::IfcSite::REF_LONGITUDE.index());
            let (Some(mut latitude), Some(mut longitude)) = (latitude, longitude) else {
                continue;
            };

            // The `-0` leniency (TS parity, see `compoundPlaneAngleToDecimalDegrees`
            // in `georef-extractor.ts`): a writer that signs a zero-magnitude
            // component of the compound angle (e.g. `(-0, 30, 0)` for 0°30'S)
            // survives here only via the entity's RAW record bytes.
            // `compound_plane_angle_to_degrees` above already lost that sign —
            // its components come from `AttributeValue::Integer(i64)`, and the
            // shared tokenizer's `integer()` parses `-0` through
            // `lexical_core::parse::<i64>`, which has no negative-zero
            // representation, so the sign never reaches `AttributeValue` at
            // all. Re-scanning the raw bytes for this one legacy-site
            // attribute pair (RefLatitude/RefLongitude only, not the hot
            // tokenizer) recovers it without touching the shared integer path.
            if let Some(bytes) = decoder.get_raw_bytes(*id) {
                if latitude >= 0.0 && compound_angle_has_literal_negative_zero(bytes, slot::IfcSite::REF_LATITUDE.index()) {
                    latitude = -latitude;
                }
                if longitude >= 0.0 && compound_angle_has_literal_negative_zero(bytes, slot::IfcSite::REF_LONGITUDE.index()) {
                    longitude = -longitude;
                }
            }

            let elevation = site.real_at(slot::IfcSite::REF_ELEVATION).unwrap_or(0.0);

            let mut georef = GeoReference::new();
            georef.source = Some(GeoRefSource::SiteLocation);
            georef.crs_name = Some("EPSG:4326".to_string());
            georef.crs_description = Some("Legacy IfcSite geolocation".to_string());
            georef.geodetic_datum = Some("WGS84".to_string());
            georef.map_projection = Some("Geographic".to_string());
            georef.map_unit = Some("DEGREE".to_string());
            georef.eastings = longitude;
            georef.northings = latitude;
            georef.orthogonal_height = elevation;
            return Ok(Some(georef));
        }
        Ok(None)
    }
}

#[cfg(test)]
#[path = "georef_tests.rs"]
mod georef_tests;
