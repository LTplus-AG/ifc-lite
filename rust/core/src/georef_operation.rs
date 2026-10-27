// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The IFC4X3 coordinate-operation family beside `IfcMapConversion`:
//! `IfcRigidOperation`, its `IfcGeographicCRS` target, and the
//! `IfcWellKnownText` definition any `IfcCoordinateReferenceSystem` may carry.
//!
//! Twin of `packages/parser/src/georef-coordinate-operation.ts`; both halves
//! are held to `tests/fixtures/georef_vectors.json`. Split out of `georef.rs`
//! to keep that module inside its module-size budget.
//!
//! `IfcRigidOperation` is a pure translation (no rotation, no scale): "the
//! whole virtual model is translated in the same way ... using lengths to
//! translate along x,y,z; or using angles for a 2D translation (e.g., lambda,
//! phi), plus a change in height." Both coordinates share one measure type
//! (WHERE SameCoordinateType). It is read into the `GeoReference` shape with
//! an identity axis and unit scale, so every consumer of `local_to_map` /
//! `to_matrix` keeps working.

use super::{GeoRefSource, GeoReference};
use crate::decoder::EntityDecoder;
use crate::generated::IfcType;
use crate::schema_gen::{AttributeValue, DecodedEntity};
use crate::slot;

const DEGREES_PER_RADIAN: f64 = 180.0 / std::f64::consts::PI;

/// A conversion-based unit may reference another; a cycle must not recurse
/// forever. Real files nest one level (DEGREE in RADIAN).
const MAX_UNIT_DEPTH: usize = 8;

/// `UnitType` of an `IfcNamedUnit` subtype, `None` for any other entity.
fn named_unit_type(unit: &DecodedEntity) -> Option<&str> {
    match unit.ifc_type {
        IfcType::IfcSIUnit
        | IfcType::IfcConversionBasedUnit
        | IfcType::IfcConversionBasedUnitWithOffset
        | IfcType::IfcContextDependentUnit => unit.enum_at(slot::IfcNamedUnit::UNIT_TYPE),
        _ => None,
    }
}

fn is_plane_angle_unit(unit: &DecodedEntity) -> bool {
    named_unit_type(unit).is_some_and(|t| t.eq_ignore_ascii_case("PLANEANGLEUNIT"))
}

/// Degrees per unit of an `IfcNamedUnit` used as a plane-angle unit, or
/// `None` when it is not one this reader can confirm. A conversion-based unit
/// is resolved through its own declared factor (an `IfcMeasureWithUnit` in a
/// radian-based unit), so `DEGREE`, `GRAD` and any other spelling read the
/// same way without a name table.
pub(super) fn plane_angle_unit_to_degrees(decoder: &mut EntityDecoder, unit_ref: u32) -> Option<f64> {
    plane_angle_unit_depth(decoder, unit_ref, 0)
}

fn plane_angle_unit_depth(decoder: &mut EntityDecoder, unit_ref: u32, depth: usize) -> Option<f64> {
    if depth > MAX_UNIT_DEPTH {
        return None;
    }
    let unit = decoder.decode_by_id(unit_ref).ok()?;
    if !is_plane_angle_unit(&unit) {
        return None;
    }
    match unit.ifc_type {
        IfcType::IfcSIUnit => {
            let name = unit.enum_at(slot::IfcSIUnit::NAME)?;
            if !name.eq_ignore_ascii_case("RADIAN") {
                return None;
            }
            let multiplier = match unit.enum_at(slot::IfcSIUnit::PREFIX) {
                Some(prefix) => crate::units::try_si_prefix_multiplier(prefix)?,
                None => 1.0,
            };
            Some(multiplier * DEGREES_PER_RADIAN)
        }
        IfcType::IfcConversionBasedUnit => {
            let measure_ref = unit.ref_at(slot::IfcConversionBasedUnit::CONVERSION_FACTOR)?;
            let measure = decoder.decode_by_id(measure_ref).ok()?;
            let value = measure.attr(slot::IfcMeasureWithUnit::VALUE_COMPONENT)?.as_float()?;
            let component_ref = measure.ref_at(slot::IfcMeasureWithUnit::UNIT_COMPONENT)?;
            let component = plane_angle_unit_depth(decoder, component_ref, depth + 1)?;
            (value > 0.0 && value.is_finite()).then_some(value * component)
        }
        _ => None,
    }
}

/// Degrees per unit of the project's plane-angle unit: `IfcProject.UnitsInContext`
/// → `IfcUnitAssignment.Units`. With no plane-angle unit assigned the SI
/// default (radian) applies; an assigned unit this reader cannot confirm is
/// `None`.
pub(super) fn project_plane_angle_unit_to_degrees(
    decoder: &mut EntityDecoder,
    project_id: Option<u32>,
) -> Option<f64> {
    let units = project_id
        .and_then(|id| decoder.decode_by_id(id).ok())
        .and_then(|project| project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT))
        .and_then(|id| decoder.decode_by_id(id).ok())
        .and_then(|assignment| assignment.ref_list_at(slot::IfcUnitAssignment::UNITS))
        .unwrap_or_default();
    for unit_ref in units {
        let Ok(unit) = decoder.decode_by_id(unit_ref) else { continue };
        if is_plane_angle_unit(&unit) {
            return plane_angle_unit_to_degrees(decoder, unit_ref);
        }
    }
    Some(DEGREES_PER_RADIAN)
}

/// `IfcGeographicCRS`: [0] Name, [1] Description, [2] GeodeticDatum,
/// [3] PrimeMeridian, [4] AngleUnit, [5] HeightUnit. Coordinates are lon/lat
/// degrees, so the map unit is `DEGREE` with no metre scale.
pub(super) fn parse_geographic_crs(entity: &DecodedEntity, georef: &mut GeoReference) {
    // Blank reads as unset, the rule `parse_projected_crs` applies.
    if let Some(name) = entity.string_at(slot::IfcGeographicCRS::NAME).filter(|n| !n.trim().is_empty()) {
        georef.crs_name = Some(name.to_string());
    }
    if let Some(desc) = entity.string_at(slot::IfcGeographicCRS::DESCRIPTION) {
        georef.crs_description = Some(desc.to_string());
    }
    if let Some(datum) = entity.string_at(slot::IfcGeographicCRS::GEODETIC_DATUM) {
        georef.geodetic_datum = Some(datum.to_string());
    }
    georef.map_unit = Some("DEGREE".to_string());
}

/// The first `IfcWellKnownText` literal (trimmed, non-empty) whose
/// CoordinateReferenceSystem is `crs_id`.
pub(super) fn well_known_text_for(
    decoder: &mut EntityDecoder,
    crs_id: u32,
    wkt_ids: &[u32],
) -> Option<String> {
    for &id in wkt_ids {
        let Ok(entity) = decoder.decode_by_id(id) else { continue };
        if entity.ref_at(slot::IfcWellKnownText::COORDINATE_REFERENCE_SYSTEM) != Some(crs_id) {
            continue;
        }
        if let Some(text) = entity.string_at(slot::IfcWellKnownText::WELL_KNOWN_TEXT).map(str::trim) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// `IFCLENGTHMEASURE(0.)` → `(name, value)`; a bare value is not a typed
/// measure and is refused.
fn typed_measure(value: Option<&AttributeValue>) -> Option<(&str, f64)> {
    match value? {
        AttributeValue::Typed { name, value } => Some((name, value.as_float()?)),
        _ => None,
    }
}

/// The target CRS a rigid operation is read against.
pub(super) struct RigidTarget {
    pub geographic: bool,
    /// Degrees per plane-angle unit; `None` when it cannot be resolved.
    pub angle_unit_to_degrees: Option<f64>,
}

/// Read one `IfcRigidOperation` — [0] SourceCRS, [1] TargetCRS,
/// [2] FirstCoordinate, [3] SecondCoordinate, [4] Height? — into `georef`,
/// or leave it untouched (refused).
///
/// Length measures translate map coordinates (first = easting, second =
/// northing). Plane-angle measures are only meaningful against an
/// `IfcGeographicCRS` and translate (lambda, phi) = (longitude, latitude),
/// converted to degrees; they are refused when the unit is unknown rather
/// than read in a guessed one. Returns `true` when the operation was read.
pub(super) fn parse_rigid_operation(
    entity: &DecodedEntity,
    target: &RigidTarget,
    georef: &mut GeoReference,
) -> bool {
    // The reason is documentation only: core has no logger, and a refused
    // operation reads as "no conversion" (the TS twin warns).
    let refuse = |_why: &str| false;
    let first = typed_measure(entity.attr(slot::IfcRigidOperation::FIRST_COORDINATE));
    let second = typed_measure(entity.attr(slot::IfcRigidOperation::SECOND_COORDINATE));
    let height = entity.real_at(slot::IfcRigidOperation::HEIGHT);
    let (Some((first_type, mut eastings)), Some((second_type, mut northings))) = (first, second) else {
        return refuse("has no typed FirstCoordinate/SecondCoordinate");
    };
    if !(eastings.is_finite() && northings.is_finite() && height.is_none_or(f64::is_finite)) {
        return refuse("has a coordinate outside the IEEE-754 double range");
    }
    if first_type != second_type {
        return refuse("mixes coordinate measure types (WHERE SameCoordinateType)");
    }
    match first_type {
        "IFCPLANEANGLEMEASURE" => {
            if !target.geographic {
                return refuse("uses plane angles against a non-geographic TargetCRS");
            }
            let Some(factor) = target.angle_unit_to_degrees.filter(|f| f.is_finite() && *f > 0.0) else {
                return refuse("uses a plane-angle unit that cannot be resolved");
            };
            eastings *= factor;
            northings *= factor;
        }
        "IFCLENGTHMEASURE" if target.geographic => {
            return refuse("uses lengths against a geographic TargetCRS");
        }
        "IFCLENGTHMEASURE" => {}
        _ => return refuse("uses a measure other than IFCLENGTHMEASURE or IFCPLANEANGLEMEASURE"),
    }
    georef.source = Some(GeoRefSource::MapConversion);
    georef.eastings = eastings;
    georef.northings = northings;
    georef.orthogonal_height = height.unwrap_or(0.0);
    georef.x_axis_abscissa = 1.0;
    georef.x_axis_ordinate = 0.0;
    georef.scale = 1.0;
    true
}
