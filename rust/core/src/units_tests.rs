// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::units`]. Split out of `units.rs` to keep that module
//! inside its module-size ratchet budget, matching the `schema_helpers.rs` /
//! `schema_helpers_tests.rs` pattern.

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
fn test_try_extract_length_unit_partial_index_defers() {
    use crate::decoder::EntityIndex;

    // Geometry-first ordering (Revit-style): the IFCPROJECT and its
    // IFCUNITASSIGNMENT / IFCSIUNIT come AFTER the geometry. A streaming
    // pre-pass that resolves units from a partial index built up to the
    // IFCPROJECT will not yet have the assigned millimetre unit.
    let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCEXTRUDEDAREASOLID(#11,#12,#13,3000.);
#100=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#200);
#200=IFCUNITASSIGNMENT((#300));
#300=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
ENDSEC;
END-ISO-10303-21;
"#;

    // Partial index: everything scanned up to (and including) the
    // IFCPROJECT, i.e. WITHOUT the assignment (#200) or the unit (#300).
    let mut partial: EntityIndex = Default::default();
    {
        let mut scanner = crate::EntityScanner::new(ifc_content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            partial.insert(id, (start, end));
            if type_name == "IFCPROJECT" {
                break;
            }
        }
    }
    assert!(!partial.contains_key(&200), "test setup: #200 must be absent");

    // With the partial index the chain is not decodable → defer (None),
    // rather than silently returning the metres default (the bug).
    let mut partial_decoder = EntityDecoder::with_index(ifc_content, partial);
    assert_eq!(
        try_extract_length_unit_scale(&mut partial_decoder, 100),
        None,
        "partial index must defer, not default to metres"
    );

    // Full index: the chain resolves to millimetres.
    let full = crate::build_entity_index(ifc_content);
    let mut full_decoder = EntityDecoder::with_index(ifc_content, full);
    assert_eq!(
        try_extract_length_unit_scale(&mut full_decoder, 100),
        Some(0.001),
        "full index must resolve millimetres"
    );
    assert!(
        (extract_length_unit_scale(&mut full_decoder, 100).unwrap() - 0.001).abs() < 1e-9
    );
}

#[test]
fn test_try_extract_length_unit_resolves_metres_when_complete() {
    // When the whole chain is present and there is no length prefix, the
    // result is a definitive metres (Some(1.0)), not a deferral.
    let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#5));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
"#;
    let mut decoder = EntityDecoder::new(ifc_content);
    assert_eq!(try_extract_length_unit_scale(&mut decoder, 1), Some(1.0));
}

#[test]
fn test_conversion_based_unit_factors() {
    // Test known imperial unit conversions
    assert_eq!(get_conversion_based_unit_factor("FOOT"), Some(0.3048));
    assert_eq!(get_conversion_based_unit_factor("foot"), Some(0.3048));
    assert_eq!(get_conversion_based_unit_factor("FEET"), Some(0.3048));
    assert_eq!(get_conversion_based_unit_factor("'FOOT'"), Some(0.3048));
    // A STEP name written `''FEET''` decodes to the four-character string
    // `'FEET'`; the TypeScript table resolves it, so this one must too, or
    // the two readers disagree about the same file.
    assert_eq!(get_conversion_based_unit_factor("'FEET'"), Some(0.3048));
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
fn test_try_extract_plane_angle_degree_full_index() {
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
    let scale = try_extract_plane_angle_to_radians(&mut decoder, 1).unwrap();
    assert!((scale - 0.0174532925199433).abs() < 1e-9, "got {}", scale);
}

#[test]
fn test_try_extract_plane_angle_incomplete_chain_returns_none() {
    // The DEGREE conversion unit is present but its IFCMEASUREWITHUNIT (#9)
    // is omitted from the index — the partial-index situation that masked
    // issue #1367. Must report None (retry) rather than the radian default.
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
    // Build an index that omits the conversion measure (#9), mimicking a
    // partial streaming index where the tail measure is not yet scanned.
    let full = crate::decoder::build_entity_index(&ifc_content);
    let partial: crate::decoder::EntityIndex =
        full.iter().filter(|(&id, _)| id != 9).map(|(&k, &v)| (k, v)).collect();
    let mut decoder = EntityDecoder::with_index(ifc_content, partial);
    assert_eq!(try_extract_plane_angle_to_radians(&mut decoder, 1), None);
}

#[test]
fn test_try_extract_plane_angle_radian_and_missing() {
    // Genuine RADIAN file resolves to Some(1.0) (NOT None) on a full index.
    let radian = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#3=IFCUNITASSIGNMENT((#5,#6));
#4=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#7=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;
    let mut decoder = EntityDecoder::new(radian);
    assert_eq!(try_extract_plane_angle_to_radians(&mut decoder, 1), Some(1.0));

    // No PLANEANGLEUNIT declared at all → radian default, fully resolved.
    let missing = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
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
    let mut decoder = EntityDecoder::new(missing);
    assert_eq!(try_extract_plane_angle_to_radians(&mut decoder, 1), Some(1.0));
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
