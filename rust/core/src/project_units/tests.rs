// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the project-units resolver. Split out of `mod.rs` so the
//! production module stays under the module-size ratchet (`tests.rs` is exempt,
//! see `rust/processing/tests/module_size_ratchet.rs`).

use super::*;
use crate::units::resolve_length_unit;

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

/// `IFCCONVERSIONBASEDUNIT.ConversionFactor` (`IFCMEASUREWITHUNIT`) can express
/// its ValueComponent against a *prefixed* SI unit, not just the bare SI base
/// (e.g. a real-world file defining INCH as `25.4` millimetres rather than
/// `0.0254` metres). `conversion_factor_scale` must fold that prefix in, or
/// the resolved si_scale is silently off by the prefix factor (1000x here).
#[test]
fn conversion_based_unit_folds_prefixed_component_scale() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#10));
#8=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(25.4),#8);
#10=IFCCONVERSIONBASEDUNIT(#11,.LENGTHUNIT.,'INCH',#9);
#11=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    let len = units.unit_for_measure("IfcLengthMeasure").unwrap();
    assert_eq!(len.symbol, "in");
    // 25.4 stated in millimetres -> 0.0254 m, NOT 25.4 m (dropped prefix).
    assert!((len.si_scale - 0.0254).abs() < 1e-12, "expected 0.0254, got {}", len.si_scale);
}

/// `IFCMEASUREWITHUNIT.UnitComponent` (`IfcUnit`) is not restricted to
/// `IfcSIUnit` — the spec allows any `IfcNamedUnit`, so a conversion-based unit
/// can be defined relative to *another* conversion-based unit (a real-world
/// chain: YARD = 3 FOOT, FOOT = 0.3048 METRE). `conversion_factor_scale` must
/// resolve that chain, not just fold in a bare/prefixed SI component — else the
/// derived unit's si_scale silently drops the FOOT factor entirely (3.0 instead
/// of 0.9144, a ~3.3x error) rather than being flagged as unresolved.
#[test]
fn conversion_based_unit_resolves_chained_conversion_component() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#20));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#5);
#7=IFCCONVERSIONBASEDUNIT(#11,.LENGTHUNIT.,'FOOT',#6);
#9=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(3.0),#7);
#20=IFCCONVERSIONBASEDUNIT(#11,.LENGTHUNIT.,'YARD',#9);
#11=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
"#;
    let units = units_of(ifc);
    let len = units.unit_for_measure("IfcLengthMeasure").unwrap();
    // 1 YARD = 3 FOOT = 3 * 0.3048 m = 0.9144 m, NOT 3.0 m (chained
    // conversion-based UnitComponent dropped to scale 1.0).
    assert!((len.si_scale - 0.9144).abs() < 1e-12, "expected 0.9144, got {}", len.si_scale);
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

/// Run `resolve_unit_by_ref(#10)` on a worker thread, failing the test if it
/// has not returned by `limit`. The timeout is the assertion: a walk that
/// regresses to `k^depth` takes seconds at k=3, so a one-second limit cannot
/// pass by accident and cannot hang the revert oracle.
fn resolve_within(
    content: String,
    limit: std::time::Duration,
) -> Option<(Option<String>, ResolvedUnit, bool)> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut decoder = EntityDecoder::new(&content);
        let _ = tx.send(resolve_unit_by_ref(&mut decoder, 10));
    });
    match rx.recv_timeout(limit) {
        Ok(out) => out,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("resolve_unit_by_ref did not return within {limit:?}")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            panic!("resolve_unit_by_ref's worker panicked (not a hang)")
        }
    }
}

/// The same cycle as above with THREE elements per level, each pointing back
/// at the derived unit. A depth cap alone bounds one path's length, not the
/// breadth: every level fans out three ways, so the walk cost `3^16` before
/// the path set refused the re-entry. The k=1 test above cannot see this,
/// being the one fan-out the cap is sufficient for.
#[test]
fn cyclic_derived_unit_with_fan_out_returns_in_bounded_time() {
    let content = "\
#10=IFCDERIVEDUNIT((#11,#12,#13),.USERDEFINED.);
#11=IFCDERIVEDUNITELEMENT(#10,1);
#12=IFCDERIVEDUNITELEMENT(#10,1);
#13=IFCDERIVEDUNITELEMENT(#10,1);
"
    .to_string();
    let out = resolve_within(content, std::time::Duration::from_secs(1));
    assert!(out.is_none(), "a derived unit made only of itself resolves to nothing");
}

/// An ACYCLIC fan-out: twelve derived units in a chain, each listing the next
/// one four times. No id repeats on any path, so the path set never fires
/// and the depth cap never binds (12 < 16); only the decode budget bounds
/// the `4^12` element resolutions, and with them the composed symbol, which
/// would otherwise be `4^12` copies of `m`. Refused, not truncated: the
/// result is `None`, not a symbol composed of whichever elements the walk
/// reached.
#[test]
fn acyclic_derived_unit_fan_out_is_refused_in_bounded_time() {
    let mut content = String::new();
    for level in 0..12u32 {
        let unit = 10 + level * 10;
        let next = unit + 10;
        content.push_str(&format!(
            "#{unit}=IFCDERIVEDUNIT((#{a},#{b},#{c},#{d}),.USERDEFINED.);\n\
             #{a}=IFCDERIVEDUNITELEMENT(#{next},1);\n\
             #{b}=IFCDERIVEDUNITELEMENT(#{next},1);\n\
             #{c}=IFCDERIVEDUNITELEMENT(#{next},1);\n\
             #{d}=IFCDERIVEDUNITELEMENT(#{next},1);\n",
            a = unit + 1,
            b = unit + 2,
            c = unit + 3,
            d = unit + 4,
        ));
    }
    content.push_str("#130=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n");
    let out = resolve_within(content, std::time::Duration::from_secs(1));
    assert!(out.is_none(), "an over-budget walk must refuse the unit, got {out:?}");
}

/// The budget on a TREE rather than a fan-out: three hundred distinct
/// elements over three hundred distinct SI units. Refused, not truncated:
/// the result is `None`, not a symbol composed of whichever elements the
/// walk reached before the budget ran out.
#[test]
fn an_over_budget_unit_graph_is_refused_not_truncated() {
    let n = 300u32;
    let elements: Vec<String> = (0..n).map(|i| format!("#{}", 100 + 2 * i)).collect();
    let mut content = format!("#10=IFCDERIVEDUNIT(({}),.USERDEFINED.);\n", elements.join(","));
    for i in 0..n {
        let (elem, unit) = (100 + 2 * i, 101 + 2 * i);
        content.push_str(&format!(
            "#{elem}=IFCDERIVEDUNITELEMENT(#{unit},1);\n#{unit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n"
        ));
    }
    let out = resolve_within(content, std::time::Duration::from_secs(1));
    assert!(out.is_none(), "an over-budget walk must refuse the unit, got {out:?}");
}

/// The budget must not bind on a real derived unit: a flow rate over a
/// conversion-based length whose factor is itself an SI unit resolves as
/// before, with decodes to spare.
#[test]
fn real_derived_units_stay_well_under_the_budget() {
    let content = "\
#10=IFCDERIVEDUNIT((#11,#12),.VOLUMETRICFLOWRATEUNIT.,$);
#11=IFCDERIVEDUNITELEMENT(#20,3);
#12=IFCDERIVEDUNITELEMENT(#21,-1);
#20=IFCCONVERSIONBASEDUNIT(*,.LENGTHUNIT.,'FOOT',#30);
#30=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#22);
#21=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#22=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
";
    let mut decoder = EntityDecoder::new(content);
    let (_, resolved, _) = resolve_unit_by_ref(&mut decoder, 10).expect("resolves");
    assert_eq!(resolved.symbol, "ft\u{00B3}/s");
    assert!((resolved.si_scale - 0.3048f64.powi(3)).abs() < 1e-12);
}

/// A cyclic element beside two sound ones poisons the whole authored unit.
/// Returning only the sound siblings would falsely report `m/s` for an
/// unresolved definition and give downstream conversions a fabricated scale.
#[test]
fn a_cyclic_element_refuses_the_whole_unit_instead_of_truncating_it() {
    let content = "\
#10=IFCDERIVEDUNIT((#11,#12,#13),.LINEARVELOCITYUNIT.,$);
#11=IFCDERIVEDUNITELEMENT(#10,1);
#12=IFCDERIVEDUNITELEMENT(#20,1);
#13=IFCDERIVEDUNITELEMENT(#21,-1);
#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#21=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
";
    let mut decoder = EntityDecoder::new(content);
    assert!(resolve_unit_by_ref(&mut decoder, 10).is_none());
}

/// A file-supplied `IfcDerivedUnitElement.Exponent` of `i32::MIN` reached
/// `superscript` as a re-signed negative magnitude and panicked with an
/// arithmetic overflow (`'-' - '0'` in `u32`). It must resolve, and an
/// exponent below `i32::MIN` must saturate rather than wrap to something
/// small and plausible.
#[test]
fn derived_unit_element_exponent_i32_min_resolves_without_panic() {
    let content = "\
#10=IFCDERIVEDUNIT((#11),.USERDEFINED.);
#11=IFCDERIVEDUNITELEMENT(#12,-2147483648);
#12=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCDERIVEDUNIT((#21),.USERDEFINED.);
#21=IFCDERIVEDUNITELEMENT(#12,-9223372036854775808);
";
    let mut decoder = EntityDecoder::new(content);
    let (_, resolved, _) = resolve_unit_by_ref(&mut decoder, 10).expect("resolves");
    assert!(resolved.symbol.starts_with("1/m"), "got {}", resolved.symbol);
    // `i64::MIN` saturates to the same exponent, so the two are identical.
    let (_, saturated, _) = resolve_unit_by_ref(&mut decoder, 20).expect("resolves");
    assert_eq!(saturated.symbol, resolved.symbol);
}

/// #4690: a conversion-based unit whose factor does not resolve and whose name
/// has no known factor is not a resolved unit through either accessor. The
/// display cases (FOOT, CUBIT) are the shared `unit_symbol_vectors.json` rows.
#[test]
fn issue_4690_an_unresolved_conversion_unit_is_not_a_resolved_unit() {
    let unknown = "DATA;\n#1=IFCPROJECT('guid',$,'Test',$,$,$,$,$,#2);\n#2=IFCUNITASSIGNMENT((#3));\n\
                   #3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'CUBIT',#5);\n\
                   #4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n\
                   #5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(457.2),#99);\nENDSEC;\n";
    assert_eq!(units_of(unknown).resolved_for_unit_type("LENGTHUNIT"), None);
    let mut decoder = EntityDecoder::new(unknown);
    assert!(resolve_unit_by_ref(&mut decoder, 3).is_none());
}

// ---- F3a (#7775): the scalar half of `ProjectUnits` --------------------------

/// A degree + millimetre project whose IFCPROJECT sits at the END of the file
/// with a space around `=`, the Revit/EDM shape that defeated a `=IFCPROJECT(`
/// literal (#1367). The measure holding the degree factor is declared last.
const MM_DEGREE_PROJECT_LAST: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#3=IFCUNITASSIGNMENT((#7,#10));
#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCCONVERSIONBASEDUNIT(#11,.PLANEANGLEUNIT.,'DEGREE',#9);
#11=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#12=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#9=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#12);
#1 = IFCPROJECT('guid',$,'Test',$,$,$,$,$,#3);
ENDSEC;
END-ISO-10303-21;
";

/// The data path's single resolution: the table and the scalars of one
/// `ProjectUnits` agree with the standalone resolvers they replace.
#[test]
fn resolve_file_carries_the_length_and_angle_scalars() {
    let mut decoder = EntityDecoder::new(MM_DEGREE_PROJECT_LAST);
    let units = ProjectUnits::resolve_file(&mut decoder);
    assert_eq!(units.project_id(), Some(1));
    assert_eq!(units.length_unit_scale(), 0.001);
    assert!((units.plane_angle_to_radians() - 0.0174532925199433).abs() < 1e-15);
    assert_eq!(units.length_unit().unusable_factor, None);
    // The table half still answers.
    assert_eq!(units.unit_for_measure("IfcLengthMeasure").unwrap().symbol, "mm");

    // Numerical equality with the ladder and the single-purpose resolvers.
    let scales = UnitScales::resolve(MM_DEGREE_PROJECT_LAST.as_bytes(), None, &mut EntityDecoder::new(MM_DEGREE_PROJECT_LAST));
    assert_eq!(units.scales(), scales);
    let mut fresh = EntityDecoder::new(MM_DEGREE_PROJECT_LAST);
    assert_eq!(resolve_length_unit(&mut fresh, 1).unwrap().scale, units.length_unit_scale());
    assert_eq!(fresh.length_unit_scale(), units.length_unit_scale());
}

#[test]
fn resolve_file_without_a_project_defaults_to_metres_and_radians() {
    let ifc = "ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$);\nENDSEC;\n";
    let mut decoder = EntityDecoder::new(ifc);
    let units = ProjectUnits::resolve_file(&mut decoder);
    assert_eq!((units.project_id(), units.length_unit_scale(), units.plane_angle_to_radians()), (None, 1.0, 1.0));
}

/// C6's contract (F3a): the DATA path keeps main's value for an unusable
/// factor and never refuses; geometry reads the same unit and refuses.
#[test]
fn an_unusable_length_factor_keeps_the_data_value_and_flags_geometry() {
    let ifc = |factor: &str| format!("ISO-10303-21;
DATA;
#1=IFCPROJECT('g',$,'P',$,$,$,$,$,#3);
#3=IFCUNITASSIGNMENT((#4));
#4=IFCCONVERSIONBASEDUNIT(#5,.LENGTHUNIT.,'CUSTOM',#6);
#5=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE({factor}),#7);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
");
    for (factor, data_scale) in [("1.E400", f64::INFINITY), ("0.", 1.0)] {
        let text = ifc(factor);
        let mut decoder = EntityDecoder::new(&text);
        let units = ProjectUnits::resolve_file(&mut decoder);
        assert_eq!(units.length_unit_scale(), data_scale, "factor {factor}: main's value");
        assert_eq!(units.length_unit().unusable_factor, Some(6), "factor {factor}");
        assert!(units.length_unit().for_geometry().is_err(), "factor {factor}: geometry refuses");
        // The standalone data-path resolver says the same.
        assert_eq!(resolve_length_unit(&mut EntityDecoder::new(&text), 1).unwrap(), units.length_unit());
    }
}
