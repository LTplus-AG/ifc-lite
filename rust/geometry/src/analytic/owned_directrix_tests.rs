// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Round-three retained-authored regression invariants; no SDK qualification.
use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};

const RATIONAL: &str = "#1=IFCCARTESIANPOINT((2.,0.,0.));\n\
#2=IFCCARTESIANPOINT((2.,2.,0.));\n#3=IFCCARTESIANPOINT((0.,2.,0.));\n\
#4=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1,#2,#3),.CIRCULAR_ARC.,.F.,.F.,(3,3),(2.,6.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\n\
#5=IFCCARTESIANPOINT((99.,98.,0.));\n\
#6=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(3.),#5),(IFCPARAMETERVALUE(5.)),.T.,.PARAMETER.);\n\
#7=IFCSWEPTDISKSOLID(#4,0.1,$,3.5,4.5);\n\
#8=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#6);\n";

fn owned(data: &str, id: u32) -> AnalyticDirectrix {
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let curve = decoder.decode_by_id(id).unwrap();
    extract_owned_directrix(&curve, &mut decoder).unwrap()
}

#[test]
fn original_rational_coefficients_and_parameter_domain_are_not_fitted() {
    for (id, range) in [(4, [2., 6.]), (6, [3., 5.])] {
        let result = owned(RATIONAL, id);
        assert_eq!(result.status, AnalyticStatus::Complete);
        assert_eq!(result.source.capture_status, AnalyticStatus::Complete);
        let Some(OwnedDirectrix::Rational(curve)) = result.geometry else {
            panic!("missing rational");
        };
        assert_eq!(curve.source_entity_id, 4);
        assert_eq!(curve.degree, 2);
        assert_eq!(
            curve.control_points,
            vec![[2., 0., 0.], [2., 2., 0.], [0., 2., 0.]]
        );
        assert_eq!(curve.weights, vec![1., std::f64::consts::FRAC_1_SQRT_2, 1.]);
        assert_eq!(curve.knots, vec![2., 6.]);
        assert_eq!(curve.multiplicities, vec![3, 3]);
        assert_eq!(curve.expanded_knots, vec![2., 2., 2., 6., 6., 6.]);
        assert_eq!(curve.parameter_range, range);
        // Independent conic invariant at basis parameter 4 (Bernstein t=1/2):
        // weighted quadratic is on the original radius-two circle at 45 degrees.
        let factors = [0.25, 0.5, 0.25];
        let denominator: f64 = factors.iter().zip(&curve.weights).map(|(b, w)| b * w).sum();
        let point: [f64; 3] = std::array::from_fn(|axis| {
            factors
                .iter()
                .zip(&curve.weights)
                .zip(&curve.control_points)
                .map(|((b, w), p)| b * w * p[axis])
                .sum::<f64>()
                / denominator
        });
        assert!((point[0] - 2_f64.sqrt()).abs() < 1e-14);
        assert!((point[0].hypot(point[1]) - 2.).abs() < 1e-14);
        assert_eq!(
            result.source.records[&4].attributes["CurveForm"],
            SourceValue::Enum("CIRCULAR_ARC".into())
        );
        if id == 6 {
            assert_eq!(
                result.source.records[&6].attributes["Trim1"],
                SourceValue::List(vec![
                    SourceValue::Typed {
                        name: "IFCPARAMETERVALUE".into(),
                        value: Box::new(SourceValue::Real(3.))
                    },
                    SourceValue::EntityRef(5)
                ])
            );
            assert!(result.source.records.contains_key(&5));
        }
    }
}

#[test]
fn swept_disk_retains_solid_bounds_and_original_graph_beside_owned_rational() {
    let mut decoder =
        EntityDecoder::with_index(RATIONAL.as_bytes(), build_entity_index(RATIONAL.as_bytes()));
    let solid = decoder.decode_by_id(7).unwrap();
    let disk = extract_swept_disk(&solid, &mut decoder).unwrap();
    assert!(disk.segments.is_empty());
    assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
    assert_eq!((disk.start_param, disk.end_param), (Some(3.5), Some(4.5)));
    let Some(OwnedDirectrix::Rational(curve)) = disk.owned_directrix else {
        panic!("missing disk coefficients");
    };
    assert_eq!(curve.parameter_range, [3.5, 4.5]);
    let source = disk.source.unwrap();
    assert_eq!(source.capture_status, AnalyticStatus::Complete);
    assert_eq!(source.root_entity_id, 7);
    assert_eq!(
        source.records[&7].attributes["StartParam"],
        SourceValue::Real(3.5)
    );
    assert_eq!(
        source.records[&7].attributes["EndParam"],
        SourceValue::Real(4.5)
    );
    assert_eq!(
        source.records[&4].attributes["Knots"],
        SourceValue::List(vec![SourceValue::Real(2.), SourceValue::Real(6.)])
    );
    let profile = decoder.decode_by_id(8).unwrap();
    assert!(matches!(
        extract_analytic_profile(&profile, &mut decoder).status,
        AnalyticStatus::Unsupported(_)
    ));
    // Profile topology refusal does not block the independent owned source route.
    assert_eq!(owned(RATIONAL, 6).status, AnalyticStatus::Complete);
}

#[test]
fn unsupported_rational_trim_conventions_keep_original_selectors_and_status() {
    for data in [
        RATIONAL.replace(".T.,.PARAMETER.", ".F.,.PARAMETER."),
        RATIONAL.replace(".T.,.PARAMETER.", ".T.,.CARTESIAN."),
        RATIONAL.replace("IFCPARAMETERVALUE(3.)", "IFCPARAMETERVALUE(7.)"),
    ] {
        let result = owned(&data, 6);
        assert!(matches!(result.status, AnalyticStatus::Unsupported(_)));
        assert!(result.geometry.is_none());
        assert_eq!(result.source.capture_status, AnalyticStatus::Complete);
        assert!(result.source.records.contains_key(&6));
        assert!(result.source.records.contains_key(&4));
        assert!(result.source.records.contains_key(&5));
    }
}

#[test]
fn nonunit_line_ratios_and_magnitude_respect_parameter_and_cartesian_master() {
    for master in ["PARAMETER", "CARTESIAN"] {
        let parameters = if master == "PARAMETER" {
            (2., 4.)
        } else {
            (100., 200.)
        };
        let data = format!(
            "#1=IFCCARTESIANPOINT((1.,2.,0.));\n#2=IFCDIRECTION((3.,4.,0.));\n\
#3=IFCVECTOR(#2,10.);\n#4=IFCLINE(#1,#3);\n\
#5=IFCCARTESIANPOINT((13.,18.,0.));\n#6=IFCCARTESIANPOINT((25.,34.,0.));\n\
#7=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE({}),#5),(IFCPARAMETERVALUE({}),#6),.T.,.{master}.);",
            parameters.0, parameters.1
        );
        let result = owned(&data, 7);
        assert_eq!(result.status, AnalyticStatus::Complete);
        assert_eq!(
            result.geometry,
            Some(OwnedDirectrix::Segments(vec![AnalyticCurveSegment::Line {
                start: [13., 18., 0.],
                end: [25., 34., 0.],
            }]))
        );
        assert_eq!(
            result.source.records[&2].attributes["DirectionRatios"],
            SourceValue::List(vec![
                SourceValue::Real(3.),
                SourceValue::Real(4.),
                SourceValue::Real(0.)
            ])
        );
        assert_eq!(
            result.source.records[&3].attributes["Magnitude"],
            SourceValue::Real(10.)
        );
    }
}

#[test]
fn coefficient_capture_refusal_does_not_reject_existing_interpreted_geometry() {
    // Existing line interpretation accepts point-like ratios without a type check.
    // Provenance enforces the EXPRESS edge, but must not change that old behavior.
    let data = "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCCARTESIANPOINT((3.,4.));\n\
#3=IFCVECTOR(#2,10.);\n#4=IFCLINE(#1,#3);";
    let result = owned(data, 4);
    assert_eq!(result.status, AnalyticStatus::Complete);
    let AnalyticStatus::Unsupported(reason) = result.source.capture_status else {
        panic!("capture accepted malformed edge");
    };
    assert!(reason.contains("source coefficient dependency"));
    assert!(result.source.records.is_empty());
    assert_eq!(
        result.geometry,
        Some(OwnedDirectrix::Segments(vec![AnalyticCurveSegment::Line {
            start: [0., 0., 0.],
            end: [6., 8., 0.],
        }]))
    );
}

#[test]
fn actual_source_record_budget_does_not_truncate_existing_composite_output() {
    // 20,001 lines produce 100,006 source records (including segment records),
    // over the real 100,000 capture cap, but only 60,004 analytic visits/output.
    // Thus this tests the asymmetric old limits rather than a lowered test cap.
    use std::fmt::Write;
    let count = 20_001_u32;
    let mut data = String::new();
    for index in 0..count {
        let base = 1 + index * 5;
        writeln!(data, "#{base}=IFCCARTESIANPOINT(({},0.,0.));", index).unwrap();
        writeln!(data, "#{}=IFCDIRECTION((3.,0.,0.));", base + 1).unwrap();
        writeln!(data, "#{}=IFCVECTOR(#{},1.);", base + 2, base + 1).unwrap();
        writeln!(data, "#{}=IFCLINE(#{base},#{});", base + 3, base + 2).unwrap();
        writeln!(
            data,
            "#{}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{});",
            base + 4,
            base + 3
        )
        .unwrap();
    }
    let root = count * 5 + 1;
    write!(data, "#{root}=IFCCOMPOSITECURVE((").unwrap();
    for index in 0..count {
        if index > 0 {
            data.push(',');
        }
        write!(data, "#{}", 5 + index * 5).unwrap();
    }
    data.push_str("),.F.);\n");
    let result = owned(&data, root);
    assert_eq!(result.status, AnalyticStatus::Complete);
    let Some(OwnedDirectrix::Segments(segments)) = result.geometry else {
        panic!("lost interpreted geometry");
    };
    assert_eq!(segments.len(), count as usize);
    assert_eq!(
        segments.last(),
        Some(&AnalyticCurveSegment::Line {
            start: [20_000., 0., 0.],
            end: [20_001., 0., 0.],
        })
    );
    let AnalyticStatus::Unsupported(reason) = result.source.capture_status else {
        panic!("capture budget did not fire");
    };
    assert!(reason.contains("source records exceed work budget"));
    assert!(result.source.records.is_empty());
}

#[test]
fn profile_capture_failure_preserves_complete_area_and_perimeter() {
    // Closed 2x1 rectangle; a point-like direction was accepted by the old
    // interpreter, while the stricter source graph refuses that EXPRESS edge.
    let data = b"#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCCARTESIANPOINT((3.,0.));\n\
#3=IFCVECTOR(#2,2.);\n#4=IFCLINE(#1,#3);\n\
#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);\n\
#6=IFCCARTESIANPOINT((2.,0.));\n#7=IFCCARTESIANPOINT((2.,1.));\n#8=IFCCARTESIANPOINT((0.,1.));\n\
#9=IFCPOLYLINE((#6,#7,#8,#1));\n#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);\n\
#11=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9);\n#12=IFCCOMPOSITECURVE((#10,#11),.F.);\n\
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);";
    let mut decoder = EntityDecoder::with_index(data, build_entity_index(data));
    let profile = decoder.decode_by_id(13).unwrap();
    let result = extract_analytic_profile(&profile, &mut decoder);
    assert_eq!(result.status, AnalyticStatus::Complete);
    assert_eq!(result.loops.len(), 1);
    assert_eq!(result.loops[0].signed_area, 2.);
    assert_eq!(result.loops[0].perimeter, 6.);
    let source = result.loops[0].source.as_ref().unwrap();
    assert!(matches!(
        source.capture_status,
        AnalyticStatus::Unsupported(_)
    ));
    assert!(source.records.is_empty());
}

#[test]
fn trimmed_rational_disk_and_ambiguous_solid_bounds_remain_distinct() {
    for (bounds, complete) in [("$,$", true), ("3.5,4.5", false)] {
        let data = RATIONAL.replace("#4,0.1,$,3.5,4.5", &format!("#6,0.1,$,{bounds}"));
        let mut decoder =
            EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
        let solid = decoder.decode_by_id(7).unwrap();
        let disk = extract_swept_disk(&solid, &mut decoder).unwrap();
        let source = disk.source.unwrap();
        assert_eq!(source.capture_status, AnalyticStatus::Complete);
        assert_eq!(
            source.records[&7].attributes["Directrix"],
            SourceValue::EntityRef(6)
        );
        if complete {
            let Some(OwnedDirectrix::Rational(curve)) = disk.owned_directrix else {
                panic!("missing trimmed coefficients");
            };
            assert_eq!(curve.parameter_range, [3., 5.]);
        } else {
            assert!(disk.owned_directrix.is_none());
            let AnalyticStatus::Unsupported(reason) = disk.status else {
                panic!("ambiguous domain admitted");
            };
            assert!(reason.contains("solid-level bounds on a trimmed rational"));
            assert_eq!(
                source.records[&7].attributes["StartParam"],
                SourceValue::Real(3.5)
            );
        }
    }
}

#[test]
fn invalid_rational_coefficients_are_explicitly_refused_without_losing_originals() {
    for data in [
        RATIONAL.replace("(3,3),(2.,6.)", "(2,3),(2.,6.)"),
        RATIONAL.replace("(3,3),(2.,6.)", "(3,3),(6.,2.)"),
        RATIONAL.replace("(1.,0.7071067811865476,1.)", "(1.,0.,1.)"),
    ] {
        let result = owned(&data, 4);
        assert!(result.geometry.is_none());
        assert!(matches!(result.status, AnalyticStatus::Unsupported(_)));
        assert_eq!(result.source.capture_status, AnalyticStatus::Complete);
        assert!(result.source.records[&4]
            .attributes
            .contains_key("WeightsData"));
        assert!(result.source.records[&4]
            .attributes
            .contains_key("KnotMultiplicities"));
    }
}

#[test]
fn actual_source_value_budget_does_not_change_existing_line_interpretation() {
    // The legacy reader uses the first three ratios. Capture must bound the
    // whole supplied value list independently, using its real 1,000,000 cap.
    let ratios = format!("3.,4.,{}0.", "0.,".repeat(999_998));
    let data = format!(
        "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCDIRECTION(({ratios}));\n\
#3=IFCVECTOR(#2,10.);\n#4=IFCLINE(#1,#3);"
    );
    let result = owned(&data, 4);
    assert_eq!(result.status, AnalyticStatus::Complete);
    assert_eq!(
        result.geometry,
        Some(OwnedDirectrix::Segments(vec![AnalyticCurveSegment::Line {
            start: [0., 0., 0.],
            end: [6., 8., 0.],
        }]))
    );
    let AnalyticStatus::Unsupported(reason) = result.source.capture_status else {
        panic!("capture value budget did not fire");
    };
    assert!(reason.contains("source values exceed work budget"));
    assert!(result.source.records.is_empty());
}
