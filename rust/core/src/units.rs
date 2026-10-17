// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit extraction and conversion for IFC files
//!
//! Handles parsing of IFCSIUNIT and IFCCONVERSIONBASEDUNIT (imperial units)
//! and applying appropriate multipliers to geometry coordinates.

use crate::decoder::EntityDecoder;
use crate::error::{Error, Result};
use crate::schema_gen::DecodedEntity;

#[path = "units_length.rs"]
mod length;
pub use length::{resolve_length_unit, LengthUnit};

/// The unit-label tables live in [`crate::unit_labels`], shared with the
/// georeferencing MapUnit reader; re-exported here so the `units::` paths
/// callers already use keep working.
pub use crate::unit_labels::{
    get_conversion_based_unit_factor, get_si_prefix_multiplier, try_si_prefix_multiplier,
};

/// The units a project's `IFCUNITASSIGNMENT` lists, as entity ids, in file
/// order: the one walk `IFCPROJECT` (attr 8) → `IFCUNITASSIGNMENT` (attr 0)
/// every resolver here shares.
///
/// - `Ok(Some(ids))`: the assignment was read (ids that are not references
///   are dropped).
/// - `Ok(None)`: the project declares no units (not an `IFCPROJECT`, no
///   `UnitsInContext` reference, a wrong-typed or list-less assignment), so
///   each resolver's default applies.
/// - `Err`: the project or its assignment does not decode, which on a partial
///   index means "not indexed yet".
fn assigned_units(decoder: &mut EntityDecoder, project_id: u32) -> Result<Option<Vec<u32>>> {
    let project = decoder.decode_by_id(project_id)?;
    if project.ifc_type.as_str() != "IFCPROJECT" {
        return Ok(None); // Not a project.
    }
    // IFCPROJECT attribute 8: UnitsInContext (IFCUNITASSIGNMENT).
    let Some(units_ref) = project.get(8).and_then(|attr| attr.as_entity_ref()) else {
        return Ok(None);
    };
    let assignment = decoder.decode_by_id(units_ref)?;
    if assignment.ifc_type.as_str() != "IFCUNITASSIGNMENT" {
        return Ok(None);
    }
    // IFCUNITASSIGNMENT has a single attribute: Units (list of IFCUNIT).
    Ok(assignment
        .get(0)
        .and_then(|attr| attr.as_list())
        .map(|list| list.iter().filter_map(|unit| unit.as_entity_ref()).collect()))
}

/// Is this unit declared for `unit_type` (`"LENGTHUNIT"`, `"PLANEANGLEUNIT"`)?
/// `IFCSIUNIT` and `IFCCONVERSIONBASEDUNIT` both carry `UnitType` at attr 1.
fn is_unit_type(unit: &DecodedEntity, unit_type: &str) -> bool {
    unit.get(1).and_then(|attr| attr.as_enum()) == Some(unit_type)
}

/// The SI-prefix multiplier of an `IFCSIUNIT` (attr 2): absent, `$` or
/// unreadable means the base unit.
fn si_prefix_scale(unit: &DecodedEntity) -> f64 {
    match unit.get(2) {
        Some(prefix) if !prefix.is_null() => prefix.as_enum().map_or(1.0, get_si_prefix_multiplier),
        _ => 1.0,
    }
}

/// Extract length unit scale factor from IFC file
///
/// Follows the chain: IFCPROJECT → IFCUNITASSIGNMENT → IFCSIUNIT
/// Returns the multiplier to convert coordinates to base meters
///
/// # Arguments
/// * `decoder` - Entity decoder for the IFC file
/// * `project_id` - Entity ID of the IFCPROJECT
///
/// # Returns
/// Scale factor to apply to all coordinates (e.g., 0.001 for millimeters).
/// An error when the length unit is an `IFCCONVERSIONBASEDUNIT` whose
/// `ConversionFactor` is not a positive finite number (#7678): the declared
/// unit is unknown, not metres.
///
/// A conversion-based unit resolves its NAME first (the exact ratios of
/// [`get_conversion_based_unit_factor`]) and only then its declared factor.
/// This is the precedence geometry meshes with; display ([`ProjectUnits`])
/// reads the factor first (see its docs).
pub fn extract_length_unit_scale(decoder: &mut EntityDecoder, project_id: u32) -> Result<f64> {
    let Some(units) = assigned_units(decoder, project_id)? else {
        return Ok(1.0); // No units defined, default to meters
    };
    // Search for length unit (IFCSIUNIT or IFCCONVERSIONBASEDUNIT)
    for unit_ref in units {
        let Ok(unit) = decoder.decode_by_id(unit_ref) else {
            continue; // Failed to decode, skip
        };
        match unit.ifc_type.as_str() {
            // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
            "IFCSIUNIT" if is_unit_type(&unit, "LENGTHUNIT") => return Ok(si_prefix_scale(&unit)),
            // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType, [2] Name
            // ('FOOT', 'INCH'), [3] ConversionFactor (IFCMEASUREWITHUNIT)
            "IFCCONVERSIONBASEDUNIT" if is_unit_type(&unit, "LENGTHUNIT") => {
                // Try to get the unit name first for known conversion factors
                if let Some(factor) = unit
                    .get(2)
                    .and_then(|name| name.as_string())
                    .and_then(get_conversion_based_unit_factor)
                {
                    return Ok(factor);
                }
                // If name lookup fails, try to extract from ConversionFactor.
                let Some(conversion_factor_ref) = unit.get_ref(3) else {
                    continue;
                };
                return conversion_factor_length_scale(decoder, conversion_factor_ref);
            }
            _ => {}
        }
    }

    // No length unit found, default to meters
    Ok(1.0)
}

/// The metre scale of a conversion-based length unit's `ConversionFactor`
/// (`IFCMEASUREWITHUNIT`), or the refusal of an unusable one.
///
/// A declared factor that is not a positive finite number is an error, never
/// a metre default: an unreadable one read FOOT-like custom units as metres
/// (3.28x), an overflowing `1.E400` as infinity (#7678, CORE-15).
/// `ProjectUnits` (#4690) refuses too. [`resolve_length_unit`] is the one
/// home of what callers do next.
fn conversion_factor_length_scale(decoder: &mut EntityDecoder, factor_ref: u32) -> Result<f64> {
    let unusable = |overflowed| Error::UnusableUnitFactor { factor: factor_ref, overflowed };
    // IFCMEASUREWITHUNIT: [0] ValueComponent, [1] UnitComponent
    let measure_with_unit = decoder.decode_by_id(factor_ref).map_err(|_| unusable(false))?;
    // `as_float` unwraps typed values and reads integers too.
    let raw = measure_with_unit.get(0).and_then(|attr| attr.as_float());
    let conversion_value = raw
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| unusable(raw == Some(f64::INFINITY)))?;

    // IMPORTANT: ValueComponent is expressed in UnitComponent's units.
    // If UnitComponent is a prefixed SI unit (e.g., millimeters),
    // we must multiply by that unit's scale factor.
    let unit_component_scale = measure_with_unit
        .get_ref(1)
        .and_then(|component| decoder.decode_by_id(component).ok())
        .filter(|component| component.ifc_type.as_str() == "IFCSIUNIT")
        .map_or(1.0, |component| si_prefix_scale(&component));
    Ok(conversion_value * unit_component_scale)
}

/// Resolve the length-unit scale ONLY when the full unit chain
/// (IFCPROJECT → IFCUNITASSIGNMENT → IFCSIUNIT) is decodable from the
/// decoder's current index.
///
/// Returns:
/// - `Some(scale)` when resolution is definitive — either a length unit was
///   found, or every referenced unit decoded and none was a length unit
///   (genuine base-metres default).
/// - `None` when a referenced entity in the chain could not be decoded from
///   the current (possibly partial) index, OR a conversion-based length unit
///   was hit. The caller should retry against a *complete* index before
///   trusting a metres default.
///
/// This exists for the streaming pre-pass, which resolves units from a
/// partial entity index built mid-scan. Many real exports (e.g. Revit) place
/// the IFCPROJECT / IFCUNITASSIGNMENT *after* the bulk of geometry, so the
/// partial index does not yet contain the assigned IFCSIUNIT — and silently
/// defaulting to metres there renders a millimetre model 1000× oversized.
pub fn try_extract_length_unit_scale(decoder: &mut EntityDecoder, project_id: u32) -> Option<f64> {
    // Project and assignment must decode; the gate that calls us guarantees
    // the project is indexed, and an assignment missing from the index means
    // the chain is incomplete: signal the caller to retry with a full index.
    let Some(units) = assigned_units(decoder, project_id).ok()? else {
        return Some(1.0);
    };
    let mut saw_undecodable = false;
    for unit_ref in units {
        let Ok(unit) = decoder.decode_by_id(unit_ref) else {
            // A unit referenced by the assignment is missing from this index;
            // it might be the length unit, so we cannot resolve confidently.
            saw_undecodable = true;
            continue;
        };
        match unit.ifc_type.as_str() {
            "IFCSIUNIT" if is_unit_type(&unit, "LENGTHUNIT") => return Some(si_prefix_scale(&unit)),
            // Imperial/conversion length units need a deeper chain (name +
            // IFCMEASUREWITHUNIT). Defer to the full-index path rather than
            // reimplement that walk here.
            "IFCCONVERSIONBASEDUNIT" if is_unit_type(&unit, "LENGTHUNIT") => return None,
            _ => {}
        }
    }

    // No length unit found in the list. If everything decoded, the file
    // genuinely uses base metres; otherwise the length unit may be among the
    // entities we could not decode yet — ask the caller to retry.
    (!saw_undecodable).then_some(1.0)
}

/// Partial-index-safe sibling of [`extract_plane_angle_to_radians`].
///
/// The streaming meta gate resolves units against a PARTIAL entity index (only
/// the file head scanned so far). [`extract_plane_angle_to_radians`] returns
/// `Ok(1.0)` BOTH for a genuine radian/missing-unit file AND when a PLANEANGLEUNIT
/// is declared but its conversion chain (`IFCMEASUREWITHUNIT`) is not yet indexed
/// — the caller cannot tell "really radians" from "couldn't resolve yet". This
/// variant returns `None` for the latter so `UnitScales::resolve` can retry
/// against a full index, mirroring [`try_extract_length_unit_scale`]. Without it
/// a Revit/EDM export whose DEGREE unit is early but whose `IFCMEASUREWITHUNIT`
/// is at the file tail silently defaulted to radians → degree-trimmed arcs
/// rendered as full circles (issue #1367).
pub fn try_extract_plane_angle_to_radians(
    decoder: &mut EntityDecoder,
    project_id: u32,
) -> Option<f64> {
    // Assignment not in the index ⇒ incomplete chain; signal a full-index retry.
    let Some(units) = assigned_units(decoder, project_id).ok()? else {
        return Some(1.0);
    };
    let mut saw_undecodable = false;
    for unit_ref in units {
        let Ok(unit) = decoder.decode_by_id(unit_ref) else {
            // A unit referenced by the assignment is missing from this index;
            // it might be the plane-angle unit, so we cannot resolve confidently.
            saw_undecodable = true;
            continue;
        };
        match unit.ifc_type.as_str() {
            "IFCSIUNIT" if is_unit_type(&unit, "PLANEANGLEUNIT") => {
                // SI plane-angle unit is .RADIAN.; honour exotic SI prefixes.
                return Some(si_prefix_scale(&unit));
            }
            "IFCCONVERSIONBASEDUNIT" if is_unit_type(&unit, "PLANEANGLEUNIT") => {
                // A missing ref or one not yet indexed means we cannot
                // resolve confidently — `None` makes `UnitScales::resolve`
                // retry on a full index.
                let measure = decoder.decode_by_id(unit.get_ref(3)?).ok()?;
                let value = measure.get(0).and_then(|a| a.as_float()).unwrap_or(0.0);
                return (value > 0.0 && value.is_finite()).then_some(value);
            }
            _ => {}
        }
    }

    // No plane-angle unit found. If everything decoded, the file genuinely uses
    // the radian default; otherwise it may be among the undecodable refs — retry.
    (!saw_undecodable).then_some(1.0)
}

/// Extract the multiplier that converts file plane-angle units to radians.
///
/// Follows the chain: IFCPROJECT → IFCUNITASSIGNMENT → IFCSIUNIT / IFCCONVERSIONBASEDUNIT.
/// Returns the multiplier such that `value_in_file_units * multiplier = value_in_radians`.
///
/// - `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` → `1.0`
/// - `IFCCONVERSIONBASEDUNIT(...,.PLANEANGLEUNIT.,'DEGREE',#m)` where `#m =
///   IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.01745...), <radian>)` → `0.01745...`
/// - Missing PLANEANGLEUNIT → `1.0` (radians, per IFC2x3/IFC4 spec default).
///
/// Without this, trim parameters on `IfcCircle`/`IfcEllipse` were
/// unconditionally `.to_radians()`-converted in `profiles.rs`, which silently
/// shrank 240° arcs to ~4° on files that declare `PLANEANGLEUNIT=.RADIAN.`
/// (e.g. Renga, issue #820).
pub fn extract_plane_angle_to_radians(decoder: &mut EntityDecoder, project_id: u32) -> Result<f64> {
    let Some(units) = assigned_units(decoder, project_id)? else {
        return Ok(1.0);
    };
    for unit_ref in units {
        let Ok(unit) = decoder.decode_by_id(unit_ref) else {
            continue;
        };
        match unit.ifc_type.as_str() {
            // SI plane-angle unit is .RADIAN. by definition; SI prefixes
            // (.MILLI. etc.) are legal but exotic for angles. Honor them.
            "IFCSIUNIT" if is_unit_type(&unit, "PLANEANGLEUNIT") => return Ok(si_prefix_scale(&unit)),
            "IFCCONVERSIONBASEDUNIT" if is_unit_type(&unit, "PLANEANGLEUNIT") => {
                // The conversion factor expresses (1 file-unit) in terms of its
                // UnitComponent. For PLANEANGLEUNIT the UnitComponent is required
                // by IFC to be the SI radian, so the value IS the multiplier to
                // radians and we don't need to chase UnitComponent.
                let Some(measure) = unit.get_ref(3).and_then(|r| decoder.decode_by_id(r).ok()) else {
                    continue;
                };
                // as_float() unwraps typed-value wrappers like
                // IFCRATIOMEASURE(0.01745…) automatically.
                let value = measure.get(0).and_then(|a| a.as_float()).unwrap_or(0.0);
                if value > 0.0 && value.is_finite() {
                    return Ok(value);
                }
            }
            _ => {}
        }
    }

    // No plane-angle unit declared — IFC spec default is radian.
    Ok(1.0)
}

#[cfg(test)]
#[path = "units_tests.rs"]
mod tests;
