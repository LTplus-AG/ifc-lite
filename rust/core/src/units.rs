// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit extraction and conversion for IFC files
//!
//! Handles parsing of IFCSIUNIT and IFCCONVERSIONBASEDUNIT (imperial units)
//! and applying appropriate multipliers to geometry coordinates.

use crate::decoder::EntityDecoder;
use crate::error::Result;

/// SI Prefix multipliers as defined in IFC specification
/// Maps IfcSIPrefix enum values to their numeric multipliers
#[inline]
pub fn get_si_prefix_multiplier(prefix: &str) -> f64 {
    match prefix {
        "ATTO" => 1e-18,
        "FEMTO" => 1e-15,
        "PICO" => 1e-12,
        "NANO" => 1e-9,
        "MICRO" => 1e-6,
        "MILLI" => 1e-3, // Most common: millimeters
        "CENTI" => 1e-2, // Centimeters
        "DECI" => 1e-1,  // Decimeters
        "DECA" => 1e1,   // Dekameters
        "HECTO" => 1e2,  // Hectometers
        "KILO" => 1e3,   // Kilometers
        "MEGA" => 1e6,
        "GIGA" => 1e9,
        "TERA" => 1e12,
        "PETA" => 1e15,
        "EXA" => 1e18,
        _ => 1.0, // No prefix or unknown = base unit (meters)
    }
}

/// Known conversion factors for imperial/conversion-based units to meters
/// These are the standard conversions defined in IFC specification
#[inline]
pub fn get_conversion_based_unit_factor(name: &str) -> Option<f64> {
    match name.to_uppercase().as_str() {
        // Length units to meters
        "FOOT" | "FEET" | "'FOOT'" => Some(0.3048),
        "INCH" | "'INCH'" => Some(0.0254),
        "YARD" | "'YARD'" => Some(0.9144),
        "MILE" | "'MILE'" => Some(1609.344),
        _ => None,
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
/// Scale factor to apply to all coordinates (e.g., 0.001 for millimeters)
pub fn extract_length_unit_scale(decoder: &mut EntityDecoder, project_id: u32) -> Result<f64> {
    // Decode IFCPROJECT entity
    let project = decoder.decode_by_id(project_id)?;

    if project.ifc_type.as_str() != "IFCPROJECT" {
        return Ok(1.0); // Not a project, default to meters
    }

    // IFCPROJECT structure:
    // Attribute 0: GlobalId
    // Attribute 1: OwnerHistory
    // Attribute 2: Name
    // Attribute 3: Description
    // Attribute 4: ObjectType
    // Attribute 5: LongName
    // Attribute 6: Phase
    // Attribute 7: RepresentationContexts
    // Attribute 8: UnitsInContext (IFCUNITASSIGNMENT)

    let units_attr = match project.get(8) {
        Some(attr) => attr,
        None => return Ok(1.0), // No units defined, default to meters
    };

    // Resolve IFCUNITASSIGNMENT reference
    let units_ref = match units_attr.as_entity_ref() {
        Some(ref_id) => ref_id,
        None => return Ok(1.0), // No units reference
    };

    let unit_assignment = decoder.decode_by_id(units_ref)?;

    if unit_assignment.ifc_type.as_str() != "IFCUNITASSIGNMENT" {
        return Ok(1.0); // Wrong type
    }

    // IFCUNITASSIGNMENT has a single attribute: Units (list of IFCUNIT)
    let units_list_attr = match unit_assignment.get(0) {
        Some(attr) => attr,
        None => return Ok(1.0), // No units list
    };

    let units_list = match units_list_attr.as_list() {
        Some(list) => list,
        None => return Ok(1.0), // Not a list
    };

    // Search for length unit (IFCSIUNIT or IFCCONVERSIONBASEDUNIT)
    for unit_attr in units_list {
        let unit_ref = match unit_attr.as_entity_ref() {
            Some(ref_id) => ref_id,
            None => continue,
        };

        let unit_entity = match decoder.decode_by_id(unit_ref) {
            Ok(entity) => entity,
            Err(_) => continue, // Failed to decode, skip
        };

        let unit_type_str = unit_entity.ifc_type.as_str();

        // Handle IFCSIUNIT
        if unit_type_str == "IFCSIUNIT" {
            // IFCSIUNIT structure:
            // Attribute 0: Dimensions (can be *)
            // Attribute 1: UnitType (.LENGTHUNIT., .AREAUNIT., etc.)
            // Attribute 2: Prefix (.MILLI., .CENTI., etc.) - THIS IS WHAT WE NEED!
            // Attribute 3: Name (.METRE., .SQUARE_METRE., etc.)

            // Check if this is a length unit
            let unit_type_attr = match unit_entity.get(1) {
                Some(attr) => attr,
                None => continue,
            };

            let unit_type = match unit_type_attr.as_enum() {
                Some(type_str) => type_str,
                None => continue,
            };

            if unit_type != "LENGTHUNIT" {
                continue; // Not a length unit, skip
            }

            // Extract the SI prefix (attribute 2)
            let prefix_attr = match unit_entity.get(2) {
                Some(attr) => attr,
                None => return Ok(1.0), // No prefix = base meters
            };

            // Prefix can be an enum or null ($)
            if prefix_attr.is_null() {
                return Ok(1.0); // Null means no prefix = base meters
            }

            let prefix = match prefix_attr.as_enum() {
                Some(prefix_str) => prefix_str,
                None => return Ok(1.0), // Can't read prefix, assume meters
            };

            // Calculate and return the multiplier
            return Ok(get_si_prefix_multiplier(prefix));
        }

        // Handle IFCCONVERSIONBASEDUNIT (imperial units like feet, inches)
        if unit_type_str == "IFCCONVERSIONBASEDUNIT" {
            // IFCCONVERSIONBASEDUNIT structure:
            // Attribute 0: Dimensions (can be *)
            // Attribute 1: UnitType (.LENGTHUNIT., .AREAUNIT., etc.)
            // Attribute 2: Name (string like 'FOOT', 'INCH')
            // Attribute 3: ConversionFactor (IFCMEASUREWITHUNIT reference)

            // Check if this is a length unit
            let unit_type_attr = match unit_entity.get(1) {
                Some(attr) => attr,
                None => continue,
            };

            let unit_type = match unit_type_attr.as_enum() {
                Some(type_str) => type_str,
                None => continue,
            };

            if unit_type != "LENGTHUNIT" {
                continue; // Not a length unit, skip
            }

            // Try to get the unit name first for known conversion factors
            if let Some(name_attr) = unit_entity.get(2) {
                if let Some(name) = name_attr.as_string() {
                    // Check if we have a known conversion factor for this unit
                    if let Some(factor) = get_conversion_based_unit_factor(name) {
                        return Ok(factor);
                    }
                }
            }

            // If name lookup fails, try to extract from ConversionFactor (IFCMEASUREWITHUNIT)
            // Attribute 3: ConversionFactor
            let conversion_factor_ref = match unit_entity.get_ref(3) {
                Some(ref_id) => ref_id,
                None => continue,
            };

            let measure_with_unit = match decoder.decode_by_id(conversion_factor_ref) {
                Ok(entity) => entity,
                Err(_) => continue,
            };

            // IFCMEASUREWITHUNIT structure:
            // Attribute 0: ValueComponent (the numeric value - could be Real, Integer, or Ratio)
            // Attribute 1: UnitComponent (reference to base unit)

            // Extract the numeric value from ValueComponent
            let value_attr = match measure_with_unit.get(0) {
                Some(attr) => attr,
                None => continue,
            };

            // The value could be stored as Real, Integer, or in nested form
            let conversion_value = if let Some(val) = value_attr.as_float() {
                val
            } else if let Some(val) = value_attr.as_int() {
                val as f64
            } else {
                // Default to 1.0 if we can't extract the value
                1.0
            };

            // If we got a valid conversion value, use it
            if conversion_value > 0.0 {
                // IMPORTANT: ValueComponent is expressed in UnitComponent's units.
                // If UnitComponent is a prefixed SI unit (e.g., millimeters),
                // we must multiply by that unit's scale factor.
                let mut unit_component_scale = 1.0;

                if let Some(unit_component_ref) = measure_with_unit.get_ref(1) {
                    if let Ok(unit_component) = decoder.decode_by_id(unit_component_ref) {
                        if unit_component.ifc_type.as_str() == "IFCSIUNIT" {
                            // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
                            if let Some(prefix_attr) = unit_component.get(2) {
                                if !prefix_attr.is_null() {
                                    if let Some(prefix) = prefix_attr.as_enum() {
                                        unit_component_scale = get_si_prefix_multiplier(prefix);
                                    }
                                }
                            }
                        }
                    }
                }

                return Ok(conversion_value * unit_component_scale);
            }
        }
    }

    // No length unit found, default to meters
    Ok(1.0)
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
    let project = decoder.decode_by_id(project_id)?;
    if project.ifc_type.as_str() != "IFCPROJECT" {
        return Ok(1.0);
    }

    let units_attr = match project.get(8) {
        Some(attr) => attr,
        None => return Ok(1.0),
    };
    let units_ref = match units_attr.as_entity_ref() {
        Some(ref_id) => ref_id,
        None => return Ok(1.0),
    };
    let unit_assignment = decoder.decode_by_id(units_ref)?;
    if unit_assignment.ifc_type.as_str() != "IFCUNITASSIGNMENT" {
        return Ok(1.0);
    }
    let units_list_attr = match unit_assignment.get(0) {
        Some(attr) => attr,
        None => return Ok(1.0),
    };
    let units_list = match units_list_attr.as_list() {
        Some(list) => list,
        None => return Ok(1.0),
    };

    for unit_attr in units_list {
        let unit_ref = match unit_attr.as_entity_ref() {
            Some(ref_id) => ref_id,
            None => continue,
        };
        let unit_entity = match decoder.decode_by_id(unit_ref) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        let unit_type_str = unit_entity.ifc_type.as_str();

        if unit_type_str == "IFCSIUNIT" {
            // [1]=UnitType, [2]=Prefix, [3]=Name
            let kind = unit_entity.get(1).and_then(|a| a.as_enum());
            if kind.as_deref() != Some("PLANEANGLEUNIT") {
                continue;
            }
            // SI plane-angle unit is .RADIAN. by definition; SI prefixes
            // (.MILLI. etc.) are legal but exotic for angles. Honor them.
            let prefix_scale = match unit_entity.get(2) {
                Some(p) if !p.is_null() => p
                    .as_enum()
                    .map(|s| get_si_prefix_multiplier(&s))
                    .unwrap_or(1.0),
                _ => 1.0,
            };
            return Ok(prefix_scale);
        }

        if unit_type_str == "IFCCONVERSIONBASEDUNIT" {
            // [1]=UnitType, [2]=Name, [3]=ConversionFactor (IFCMEASUREWITHUNIT)
            let kind = unit_entity.get(1).and_then(|a| a.as_enum());
            if kind.as_deref() != Some("PLANEANGLEUNIT") {
                continue;
            }
            // The conversion factor expresses (1 file-unit) in terms of its
            // UnitComponent. For PLANEANGLEUNIT the UnitComponent is required
            // by IFC to be the SI radian, so the value IS the multiplier to
            // radians and we don't need to chase UnitComponent.
            let conv_ref = match unit_entity.get_ref(3) {
                Some(r) => r,
                None => continue,
            };
            let measure = match decoder.decode_by_id(conv_ref) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let value_attr = match measure.get(0) {
                Some(a) => a,
                None => continue,
            };
            // as_float() unwraps typed-value wrappers like
            // IFCRATIOMEASURE(0.01745…) automatically.
            let value = value_attr.as_float().unwrap_or(0.0);
            if value > 0.0 && value.is_finite() {
                return Ok(value);
            }
        }
    }

    // No plane-angle unit declared — IFC spec default is radian.
    Ok(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_si_prefix_multipliers() {
        assert_eq!(get_si_prefix_multiplier("MILLI"), 0.001);
        assert_eq!(get_si_prefix_multiplier("CENTI"), 0.01);
        assert_eq!(get_si_prefix_multiplier("DECI"), 0.1);
        assert_eq!(get_si_prefix_multiplier("KILO"), 1000.0);
        assert_eq!(get_si_prefix_multiplier(""), 1.0);
        assert_eq!(get_si_prefix_multiplier("UNKNOWN"), 1.0);
    }

    #[test]
    fn test_extract_unit_from_real_file() {
        // Test with a minimal IFC snippet that has millimeter units
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#6=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_length_unit_scale(&mut decoder, 1).unwrap();

        // Should be 0.001 for millimeters
        assert!(
            (scale - 0.001).abs() < 0.0001,
            "Expected 0.001 for MILLI, got {}",
            scale
        );
    }

    #[test]
    fn test_extract_unit_meters() {
        // Test with meters (no prefix)
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_length_unit_scale(&mut decoder, 1).unwrap();

        // Should be 1.0 for meters (no prefix)
        assert!(
            (scale - 1.0).abs() < 0.0001,
            "Expected 1.0 for meters, got {}",
            scale
        );
    }

    #[test]
    fn test_conversion_based_unit_factors() {
        // Test known imperial unit conversions
        assert_eq!(get_conversion_based_unit_factor("FOOT"), Some(0.3048));
        assert_eq!(get_conversion_based_unit_factor("foot"), Some(0.3048));
        assert_eq!(get_conversion_based_unit_factor("FEET"), Some(0.3048));
        assert_eq!(get_conversion_based_unit_factor("'FOOT'"), Some(0.3048));
        assert_eq!(get_conversion_based_unit_factor("INCH"), Some(0.0254));
        assert_eq!(get_conversion_based_unit_factor("YARD"), Some(0.9144));
        assert_eq!(get_conversion_based_unit_factor("MILE"), Some(1609.344));
        assert_eq!(get_conversion_based_unit_factor("UNKNOWN_UNIT"), None);
    }

    #[test]
    fn test_extract_plane_angle_radian() {
        // Renga-style: PLANEANGLEUNIT is .RADIAN. — trim values are in radians.
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5,#6));
#4=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#6=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#7=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;
        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_plane_angle_to_radians(&mut decoder, 1).unwrap();
        assert!(
            (scale - 1.0).abs() < 1e-9,
            "expected 1.0 for RADIAN, got {}",
            scale
        );
    }

    #[test]
    fn test_extract_plane_angle_degree() {
        // Revit-style: PLANEANGLEUNIT is a CONVERSIONBASEDUNIT 'DEGREE' with
        // measure 0.0174532925199433 radians-per-degree.
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5,#10));
#4=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#9=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#8);
#10=IFCCONVERSIONBASEDUNIT(#11,.PLANEANGLEUNIT.,'DEGREE',#9);
#11=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
"#;
        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_plane_angle_to_radians(&mut decoder, 1).unwrap();
        assert!(
            (scale - 0.0174532925199433).abs() < 1e-9,
            "expected 0.01745… for DEGREE, got {}",
            scale
        );
    }

    #[test]
    fn test_extract_plane_angle_missing_defaults_to_radian() {
        // No PLANEANGLEUNIT in IFCUNITASSIGNMENT — IFC spec says default is RADIAN.
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;
        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_plane_angle_to_radians(&mut decoder, 1).unwrap();
        assert!(
            (scale - 1.0).abs() < 1e-9,
            "expected 1.0 default for missing PLANEANGLEUNIT, got {}",
            scale
        );
    }

    #[test]
    fn test_decoder_plane_angle_cache() {
        // Confirms EntityDecoder::plane_angle_to_radians caches the lookup.
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5,#6));
#4=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#6=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#7=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;
        let mut decoder = EntityDecoder::new(ifc_content);
        let a = decoder.plane_angle_to_radians();
        let b = decoder.plane_angle_to_radians();
        assert_eq!(a, b);
        assert!((a - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_extract_unit_imperial_feet() {
        // Test with imperial feet units using IFCCONVERSIONBASEDUNIT
        let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCCONVERSIONBASEDUNIT(#7,.LENGTHUNIT.,'FOOT',#8);
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#9);
#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
"#;

        let mut decoder = EntityDecoder::new(ifc_content);
        let scale = extract_length_unit_scale(&mut decoder, 1).unwrap();

        // Should be 0.3048 for feet
        assert!(
            (scale - 0.3048).abs() < 0.0001,
            "Expected 0.3048 for FOOT, got {}",
            scale
        );
    }
}
