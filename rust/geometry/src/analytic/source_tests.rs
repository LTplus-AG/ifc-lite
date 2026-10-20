// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Retained source-review regression: source conventions are not derived radians.
use super::{extract_analytic_profile, AnalyticCurveSegment, AnalyticStatus, SourceValue};
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn profile(data: &[u8], id: u32) -> super::AnalyticProfile {
    let mut decoder = EntityDecoder::with_index(data, build_entity_index(data));
    let entity = decoder.decode_by_id(id).unwrap();
    extract_analytic_profile(&entity, &mut decoder)
}

fn semicircle(master: &str, sense: bool, reverse: bool) -> String {
    // Stated invariant: unit-radius half-disc, area +/-pi/2, exact arc and
    // diameter. Degree values and both selector forms describe the same bounds.
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#4=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#2);
#5=IFCCONVERSIONBASEDUNIT(#3,.PLANEANGLEUNIT.,'DEGREE',#4);
#6=IFCUNITASSIGNMENT((#1,#5));
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-7,#8,$);
#10=IFCPROJECT('0Test00000000000000003',$,'Test',$,$,$,$,(#9),#6);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCDIRECTION((1.,0.));
#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCCIRCLE(#22,1.);
#24=IFCCARTESIANPOINT((1.,0.));
#25=IFCCARTESIANPOINT((-1.,0.));
#26=IFCTRIMMEDCURVE(#23,(IFCPARAMETERVALUE(0.),#24),(IFCPARAMETERVALUE(180.),#25),.{sense}.,.{master}.);
#27=IFCPOLYLINE((#25,#24));
#28=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#26);
#29=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#27);
#30=IFCCOMPOSITECURVE((#28,#29),.F.);
#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.{traversal}.,#30);
#32=IFCCOMPOSITECURVE((#31),.F.);
#33=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#32);
ENDSEC;
END-ISO-10303-21;
"#,
        sense = if sense { "T" } else { "F" },
        traversal = if reverse { "F" } else { "T" }
    )
}

#[test]
fn trim_selectors_angle_units_and_composite_traversal_survive_interpretation() {
    for master in ["PARAMETER", "CARTESIAN"] {
        for sense in [true, false] {
            for reverse in [false, true] {
                let bytes = semicircle(master, sense, reverse);
                let original = bytes.clone();
                let p = profile(bytes.as_bytes(), 33);
                assert_eq!(
                    p.status,
                    AnalyticStatus::Complete,
                    "{master} {sense} {reverse}"
                );
                assert_eq!(bytes, original);
                let boundary = &p.loops[0];
                let expected_sign = if sense != reverse { 1.0 } else { -1.0 };
                assert!(
                    (boundary.signed_area - expected_sign * std::f64::consts::FRAC_PI_2).abs()
                        < 1e-12
                );
                let source = boundary.source.as_ref().unwrap();
                assert_eq!(source.root_entity_id, 32);
                assert!(
                    (source.plane_angle_to_radians - std::f64::consts::PI / 180.).abs() < 1e-16
                );
                let trim = &source.records[&26].attributes;
                assert_eq!(
                    trim["MasterRepresentation"],
                    SourceValue::Enum(master.into())
                );
                assert_eq!(
                    trim["SenseAgreement"],
                    SourceValue::Enum(if sense { "T" } else { "F" }.into())
                );
                assert_eq!(
                    trim["Trim2"],
                    SourceValue::List(vec![
                        SourceValue::Typed {
                            name: "IFCPARAMETERVALUE".into(),
                            value: Box::new(SourceValue::Real(180.)),
                        },
                        SourceValue::EntityRef(25)
                    ])
                );
                assert_eq!(
                    source.records[&25].attributes["Coordinates"],
                    SourceValue::List(vec![SourceValue::Real(-1.), SourceValue::Real(0.)])
                );
                assert_eq!(
                    source.records[&23].attributes["Position"],
                    SourceValue::EntityRef(22)
                );
                assert!(source.records.contains_key(&21));
                assert_eq!(
                    source.records[&31].attributes["SameSense"],
                    SourceValue::Enum(if reverse { "F" } else { "T" }.into())
                );
                let arc = boundary
                    .segments
                    .iter()
                    .find_map(|segment| match segment {
                        AnalyticCurveSegment::Arc { sweep_angle, .. } => Some(*sweep_angle),
                        _ => None,
                    })
                    .unwrap();
                assert!((arc - expected_sign * std::f64::consts::PI).abs() < 1e-12);
                // The owned original stays unchanged when a numerical consumer edits a clone.
                let mut numerical = boundary.segments.clone();
                numerical.reverse();
                assert_eq!(source.records[&26].attributes["Trim2"], trim["Trim2"]);
            }
        }
    }
}

#[test]
fn real_revit_hole_retains_source_boundaries_and_winding() {
    let p = profile(
        include_bytes!("../../tests/fixtures/issue_098_wall_W.ifc"),
        338102,
    );
    assert_eq!(p.status, AnalyticStatus::Complete);
    assert_eq!(p.loops.len(), 2);
    for boundary in &p.loops {
        let source = boundary.source.as_ref().unwrap();
        assert!(source.records.contains_key(&source.root_entity_id));
        assert!(source
            .records
            .values()
            .any(|record| record.ifc_type_name == "IfcCartesianPoint"));
    }
    assert!(p.loops[0].signed_area > 0. && p.loops[1].signed_area < 0.);
    assert_ne!(
        p.loops[0].source.as_ref().unwrap().root_entity_id,
        p.loops[1].source.as_ref().unwrap().root_entity_id
    );
}

#[test]
fn parameterized_dimensions_and_profile_position_remain_original() {
    let p = profile(
        include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc"),
        8,
    );
    let source = p.loops[0].source.as_ref().unwrap();
    assert_eq!(source.records[&8].attributes["XDim"], SourceValue::Real(1.));
    assert_eq!(
        source.records[&8].attributes["Position"],
        SourceValue::EntityRef(7)
    );
    assert_eq!(
        source.records[&7].attributes["Location"],
        SourceValue::EntityRef(6)
    );
    assert!(source.records.contains_key(&6));
}

#[test]
fn trimmed_line_keeps_raw_vector_and_descending_selector_parameters() {
    // Invariant: clockwise 2x1 rectangle. False-sense line goes from x=2 to x=0;
    // original vector coefficients remain separate from interpreted endpoints.
    let data = b"#1=IFCCARTESIANPOINT((0.,0.));\n\
#2=IFCDIRECTION((1.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n\
#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(2.)),(IFCPARAMETERVALUE(0.)),.F.,.PARAMETER.);\n\
#6=IFCCARTESIANPOINT((0.,1.));\n#7=IFCCARTESIANPOINT((2.,1.));\n\
#8=IFCCARTESIANPOINT((2.,0.));\n#9=IFCPOLYLINE((#1,#6,#7,#8));\n\
#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);\n\
#11=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9);\n\
#12=IFCCOMPOSITECURVE((#10,#11),.F.);\n\
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);";
    let p = profile(data, 13);
    assert_eq!(p.status, AnalyticStatus::Complete);
    assert!((p.loops[0].signed_area + 2.).abs() < 1e-12);
    assert_eq!(
        p.loops[0].segments[0],
        AnalyticCurveSegment::Line {
            start: [2., 0., 0.],
            end: [0., 0., 0.],
        }
    );
    let source = p.loops[0].source.as_ref().unwrap();
    assert_eq!(
        source.records[&2].attributes["DirectionRatios"],
        SourceValue::List(vec![SourceValue::Real(1.), SourceValue::Real(0.)])
    );
    assert_eq!(
        source.records[&5].attributes["Trim1"],
        SourceValue::List(vec![SourceValue::Typed {
            name: "IFCPARAMETERVALUE".into(),
            value: Box::new(SourceValue::Real(2.)),
        }])
    );
}
