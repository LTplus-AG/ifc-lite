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

/// #7678 (CORE-15): a custom-named conversion-based length unit whose factor
/// overflows (`1.E400`), cannot be read, or is not positive used to resolve
/// to infinity (every vertex inf/NaN) or to an invented 1.0 (metres, a 3.28x
/// error for a FOOT-like unit). It is now an error; the finite factor of the
/// same file still resolves.
#[test]
fn conversion_based_length_unit_with_an_unusable_factor_is_an_error() {
    let file = |factor: &str| {
        format!(
            "DATA;\n#1=IFCPROJECT('guid',$,'Test',$,$,$,$,$,#3);\n#3=IFCUNITASSIGNMENT((#5));\n\
             #5=IFCCONVERSIONBASEDUNIT(#7,.LENGTHUNIT.,'SURVEY_LINK',#8);\n\
             #7=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n\
             #8=IFCMEASUREWITHUNIT({factor},#9);\n#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\nENDSEC;\n"
        )
    };
    for factor in [
        "IFCLENGTHMEASURE(1.E400)",
        "IFCLENGTHMEASURE(-1.E400)",
        "IFCLENGTHMEASURE(0.)",
        "IFCLENGTHMEASURE(-0.)",
        "IFCLENGTHMEASURE(-0.2)",
        "IFCLABEL('one link')",
        "$",
    ] {
        let content = file(factor);
        let mut decoder = EntityDecoder::new(&content);
        let scale = extract_length_unit_scale(&mut decoder, 1);
        assert!(
            matches!(scale, Err(crate::Error::UnusableUnitFactor { factor: 8, .. })),
            "{factor}: got {scale:?}"
        );
        // The one policy (#7678): geometry refuses, the data model keeps
        // main's value: +inf for an overflowing factor, metres otherwise.
        let mut decoder = EntityDecoder::new(&content);
        let unit = resolve_length_unit(&mut decoder, 1).expect("project decodes");
        assert_eq!(unit.unusable_factor, Some(8), "{factor}");
        assert!(unit.for_geometry().is_err(), "{factor}");
        let expected = if factor == "IFCLENGTHMEASURE(1.E400)" { f64::INFINITY } else { 1.0 };
        assert_eq!(unit.scale, expected, "{factor}");
        // A strict (geometry) decoder counts the refusal; a lossless one not.
        let mut strict = EntityDecoder::new(&content).with_strict_reals();
        assert_eq!(strict.length_unit_scale(), 1.0, "{factor}: tolerance basis only");
        assert_eq!(strict.refused_records(), 1, "{factor}");
        assert_eq!(EntityDecoder::new(&content).length_unit_scale(), expected, "{factor}");
    }
    let content = file("IFCLENGTHMEASURE(0.201168)");
    let mut decoder = EntityDecoder::new(&content);
    assert_eq!(extract_length_unit_scale(&mut decoder, 1).unwrap(), 0.201168);
    let unit = resolve_length_unit(&mut EntityDecoder::new(&content), 1).unwrap();
    assert_eq!((unit.scale, unit.unusable_factor), (0.201168, None));
}

// ---- F3a (#7775): one SI-prefix table, an exact US survey foot -----------------

/// CORE-26: the multiplier reader, the display-symbol reader and the exporters'
/// prefix checks all derive from the one table; no prefix is in one and not
/// another.
#[test]
fn the_si_prefix_table_is_the_single_source() {
    use crate::project_units::symbols::si_prefix_symbol;
    assert_eq!(crate::SI_PREFIXES.len(), 16, "the IfcSIPrefix enumeration");
    for row in crate::SI_PREFIXES {
        assert_eq!(try_si_prefix_multiplier(row.name), Some(row.factor), "{}", row.name);
        assert_eq!(get_si_prefix_multiplier(row.name), row.factor, "{}", row.name);
        assert_eq!(si_prefix_symbol(row.name), row.symbol, "{}", row.name);
        assert_eq!(si_prefix_symbol(&format!(" {} ", row.name.to_lowercase())), row.symbol);
    }
    assert_eq!(try_si_prefix_multiplier("BANANA"), None);
    assert_eq!(get_si_prefix_multiplier("BANANA"), 1.0);
    assert_eq!(si_prefix_symbol("BANANA"), "");
    assert_eq!(try_si_prefix_multiplier("milli"), None, "the enum token is exact, upper case");
}

/// EXPORT-STEP-20 / CORE-26: the US survey foot is 1200/3937 m EXACTLY on every
/// path; the former core constant was the truncated 0.3048006096.
#[test]
fn the_us_survey_foot_is_exactly_1200_over_3937() {
    assert_eq!(crate::US_SURVEY_FOOT_M, 1200.0 / 3937.0);
    assert_ne!(crate::US_SURVEY_FOOT_M, 0.3048006096, "the truncated constant is gone");
    for label in ["US survey foot", "USSURVEYFEET", "ftUS", "survey feet (US)"] {
        assert_eq!(crate::unit_labels::infer_map_unit_scale(label), Some(1200.0 / 3937.0), "{label}");
    }
}

/// EXPORT-STEP-20: the conversion-unit symbol strips every quote, as the TS
/// twin does; core used to trim only the outer pair.
#[test]
fn conversion_unit_symbol_strips_every_quote() {
    use crate::project_units::symbols::conversion_unit_symbol;
    assert_eq!(conversion_unit_symbol("O''CLOCK"), "OCLOCK");
    assert_eq!(conversion_unit_symbol("'FOOT'"), "ft");
    assert_eq!(conversion_unit_symbol(" degree "), "\u{00B0}");
    assert_eq!(conversion_unit_symbol(""), "");
}

/// F3a: the decoder locates the project once, as the first in file order.
#[test]
fn the_decoder_caches_the_first_project_in_file_order() {
    let ifc = "ISO-10303-21;\nDATA;\n#9=IFCPROJECT('b',$,'B',$,$,$,$,$,$);\n#2=IFCPROJECT('a',$,'A',$,$,$,$,$,$);\nENDSEC;\n";
    let mut decoder = crate::EntityDecoder::new(ifc);
    assert_eq!(decoder.project_id(), Some(9));
    assert_eq!(decoder.project_id(), Some(9));
    assert_eq!(crate::EntityDecoder::new("DATA;\n").project_id(), None);
}
