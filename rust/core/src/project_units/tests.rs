// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the project-units resolver. Split out of `mod.rs` so the
//! production module stays under the module-size ratchet (`tests.rs` is exempt,
//! see `rust/processing/tests/module_size_ratchet.rs`).

use super::*;

fn units_of(ifc: &str) -> ProjectUnits {
    let mut decoder = EntityDecoder::new(ifc);
    ProjectUnits::resolve(&mut decoder, 1)
}

/// The exact shape from issue #1573's VZT.ifc: mm length, m2/m3, and a
/// VOLUMETRICFLOWRATEUNIT declared as a derived unit m3/s.
const VZT_LIKE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#20,$);
#3=IFCUNITASSIGNMENT((#7,#8,#9,#10));
#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#8=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#9=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#5=IFCDERIVEDUNITELEMENT(#4,3);
#6=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#11=IFCDERIVEDUNITELEMENT(#6,-1);
#10=IFCDERIVEDUNIT((#5,#11),.VOLUMETRICFLOWRATEUNIT.,$,$);
#20=IFCAXIS2PLACEMENT3D(#21,$,$);
#21=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn resolves_vzt_flow_rate_as_derived_m3_per_s() {
    let units = units_of(VZT_LIKE);
    let u = units.unit_for_measure("IfcVolumetricFlowRateMeasure").unwrap();
    assert_eq!(u.symbol, "m\u{00B3}/s");
    assert!((u.si_scale - 1.0).abs() < 1e-12);
}

#[test]
fn resolves_length_area_volume_from_file() {
    let units = units_of(VZT_LIKE);
    let len = units.unit_for_measure("IfcPositiveLengthMeasure").unwrap();
    assert_eq!(len.symbol, "mm");
    assert!((len.si_scale - 1e-3).abs() < 1e-15);
    assert_eq!(units.unit_for_measure("IfcAreaMeasure").unwrap().symbol, "m\u{00B2}");
    assert_eq!(units.unit_for_measure("IfcVolumeMeasure").unwrap().symbol, "m\u{00B3}");
}

#[test]
fn falls_back_to_si_default_when_unit_type_absent() {
    // VZT declares no PRESSUREUNIT; a pressure property still shows Pa.
    let units = units_of(VZT_LIKE);
    let p = units.unit_for_measure("IfcPressureMeasure").unwrap();
    assert_eq!(p.symbol, "Pa");
    assert!((p.si_scale - 1.0).abs() < 1e-12);
}

#[test]
fn dimensionless_and_nonmeasure_have_no_unit() {
    let units = units_of(VZT_LIKE);
    assert!(units.unit_for_measure("IfcRatioMeasure").is_none());
    assert!(units.unit_for_measure("IfcLabel").is_none());
    assert!(units.unit_for_measure("IfcCountMeasure").is_none());
}

#[test]
fn conversion_based_degree_plane_angle() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#5,#10));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#9=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#8);
#10=IFCCONVERSIONBASEDUNIT(#11,.PLANEANGLEUNIT.,'DEGREE',#9);
#11=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    let a = units.unit_for_measure("IfcPlaneAngleMeasure").unwrap();
    assert_eq!(a.symbol, "\u{00B0}");
    assert!((a.si_scale - 0.0174532925199433).abs() < 1e-15);
}

#[test]
fn kilogram_mass_unit() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#5));
#5=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    let m = units.unit_for_measure("IfcMassMeasure").unwrap();
    assert_eq!(m.symbol, "kg");
    assert!((m.si_scale - 1.0).abs() < 1e-12);
}

#[test]
fn monetary_unit_currency_symbol() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#5,#6));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCMONETARYUNIT('EUR');
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    let money = units.unit_for_measure("IfcMonetaryMeasure").unwrap();
    assert_eq!(money.symbol, "\u{20AC}");
}

#[test]
fn empty_when_no_assignment() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),$);
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    assert_eq!(units.declared_len(), 0);
    // Still yields SI defaults via unit_for_measure.
    assert_eq!(units.unit_for_measure("IfcAreaMeasure").unwrap().symbol, "m\u{00B2}");
}

/// A malformed IFCDERIVEDUNIT whose element's Unit points back to itself would
/// recurse forever (an uncatchable stack-overflow abort). With the depth cap it
/// terminates and resolves to None. NOTE: pre-fix this SIGABRTs the whole test
/// binary, so the fail-before check is a one-time manual `--test` run with the
/// fix reverted; checked in, it asserts only post-fix termination.
#[test]
fn cyclic_derived_unit_terminates_not_stack_overflow() {
    let content = "\
#10=IFCDERIVEDUNIT((#11),.USERDEFINED.);
#11=IFCDERIVEDUNITELEMENT(#10,1);
";
    let mut decoder = EntityDecoder::new(content);
    assert!(resolve_unit_by_ref(&mut decoder, 10).is_none());
}
