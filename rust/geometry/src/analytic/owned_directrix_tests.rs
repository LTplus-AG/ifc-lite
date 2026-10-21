// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept-disk directrix source and owned exact directrix (#7955 F1b).
use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};

const RATIONAL: &str = "#1=IFCCARTESIANPOINT((2.,0.,0.));\n\
#2=IFCCARTESIANPOINT((2.,2.,0.));\n#3=IFCCARTESIANPOINT((0.,2.,0.));\n\
#4=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1,#2,#3),.CIRCULAR_ARC.,.F.,.F.,(3,3),(2.,6.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\n\
#5=IFCCARTESIANPOINT((99.,98.,0.));\n\
#6=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(3.),#5),(IFCPARAMETERVALUE(5.)),.T.,.PARAMETER.);\n\
#7=IFCSWEPTDISKSOLID(#4,0.1,$,3.5,4.5);\n";

fn disk_in(data: &str, id: u32, capture: bool) -> AnalyticSweptDisk {
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let solid = decoder.decode_by_id(id).unwrap();
    if capture {
        with_source_capture(|| extract_swept_disk(&solid, &mut decoder)).unwrap()
    } else {
        extract_swept_disk(&solid, &mut decoder).unwrap()
    }
}

fn disk(data: &str, id: u32) -> AnalyticSweptDisk {
    disk_in(data, id, true)
}

fn rational(disk: &AnalyticSweptDisk) -> &OwnedRationalCurve {
    let Some(OwnedDirectrix::Rational(curve)) = &disk.owned_directrix else {
        panic!("missing owned rational directrix: {:?}", disk.owned_directrix);
    };
    curve
}

#[test]
fn rational_disk_keeps_original_coefficients_weights_and_solid_interval() {
    let disk = disk(RATIONAL, 7);
    // The line/arc interpretation is unchanged: a B-spline is not line/arc.
    assert!(disk.segments.is_empty());
    assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
    assert_eq!((disk.start_param, disk.end_param), (Some(3.5), Some(4.5)));
    let curve = rational(&disk);
    assert_eq!(curve.source_entity_id, 4);
    assert_eq!(curve.degree, 2);
    assert_eq!(curve.control_points, vec![[2., 0., 0.], [2., 2., 0.], [0., 2., 0.]]);
    assert_eq!(curve.weights, vec![1., std::f64::consts::FRAC_1_SQRT_2, 1.]);
    assert_eq!(curve.knots, vec![2., 6.]);
    assert_eq!(curve.multiplicities, vec![3, 3]);
    assert_eq!(curve.expanded_knots, vec![2., 2., 2., 6., 6., 6.]);
    // Solid bounds are the basis parameter itself, not a normalized fraction.
    assert_eq!(curve.parameter_range, [3.5, 4.5]);
    // Independent conic invariant at basis parameter 4 (Bernstein t=1/2): the
    // weighted quadratic lies on the original radius-two circle at 45 degrees,
    // so the coefficients were not fitted or rescaled.
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

    let source = disk.source.as_ref().unwrap();
    assert_eq!(source.capture_status, AnalyticStatus::Complete);
    assert_eq!(source.root_entity_id, 7);
    // One unit conversion, recorded once; lengths stay in file units.
    assert_eq!(source.plane_angle_to_radians, 1.0);
    let solid = &source.records[&7].attributes;
    assert_eq!(solid["Directrix"], SourceValue::EntityRef(4));
    assert_eq!(solid["Radius"], SourceValue::Real(0.1));
    assert_eq!(solid["StartParam"], SourceValue::Real(3.5));
    assert_eq!(solid["EndParam"], SourceValue::Real(4.5));
    let basis = &source.records[&4].attributes;
    assert_eq!(basis["CurveForm"], SourceValue::Enum("CIRCULAR_ARC".into()));
    assert_eq!(
        basis["Knots"],
        SourceValue::List(vec![SourceValue::Real(2.), SourceValue::Real(6.)])
    );
    assert!(basis.contains_key("WeightsData"));
    for point in [1, 2, 3] {
        assert!(source.records.contains_key(&point), "control point #{point}");
    }
}

#[test]
fn trimmed_rational_directrix_keeps_selectors_and_refuses_ambiguous_solid_bounds() {
    for (bounds, owned) in [("$,$", true), ("3.5,4.5", false)] {
        let data = RATIONAL.replace("#4,0.1,$,3.5,4.5", &format!("#6,0.1,$,{bounds}"));
        let disk = disk(&data, 7);
        let source = disk.source.as_ref().unwrap();
        assert_eq!(source.capture_status, AnalyticStatus::Complete);
        assert_eq!(source.records[&7].attributes["Directrix"], SourceValue::EntityRef(6));
        assert_eq!(
            source.records[&6].attributes["Trim1"],
            SourceValue::List(vec![
                SourceValue::Typed {
                    name: "IFCPARAMETERVALUE".into(),
                    value: Box::new(SourceValue::Real(3.))
                },
                SourceValue::EntityRef(5)
            ])
        );
        assert!(source.records.contains_key(&4), "rational basis is captured");
        assert!(source.records.contains_key(&5), "cartesian trim selector is captured");
        if owned {
            assert_eq!(rational(&disk).parameter_range, [3., 5.]);
        } else {
            // Solid bounds on a trimmed curve address its own domain; refuse
            // instead of reinterpreting them in the basis parameter.
            assert!(disk.owned_directrix.is_none());
        }
    }
}

#[test]
fn unsupported_rational_conventions_keep_original_records_without_owned_geometry() {
    let trimmed = RATIONAL.replace("#4,0.1,$,3.5,4.5", "#6,0.1,$,$,$");
    for data in [
        trimmed.replace(".T.,.PARAMETER.", ".F.,.PARAMETER."),
        trimmed.replace(".T.,.PARAMETER.", ".T.,.CARTESIAN."),
        trimmed.replace("IFCPARAMETERVALUE(3.)", "IFCPARAMETERVALUE(7.)"),
        RATIONAL.replace("(3,3),(2.,6.)", "(2,3),(2.,6.)"),
        RATIONAL.replace("(3,3),(2.,6.)", "(3,3),(6.,2.)"),
        RATIONAL.replace("(1.,0.7071067811865476,1.)", "(1.,0.,1.)"),
        RATIONAL.replace("3.5,4.5", "1.,4.5"),
    ] {
        let disk = disk(&data, 7);
        assert!(disk.owned_directrix.is_none(), "{data}");
        assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
        let source = disk.source.as_ref().unwrap();
        assert_eq!(source.capture_status, AnalyticStatus::Complete);
        assert!(source.records[&4].attributes.contains_key("KnotMultiplicities"));
    }
}

#[test]
fn line_arc_disk_owns_its_interpreted_segments_beside_the_source() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCCARTESIANPOINT((4.,0.,0.));\n\
#3=IFCPOLYLINE((#1,#2));\n#4=IFCSWEPTDISKSOLID(#3,0.5,0.25,$,$);";
    let disk = disk(data, 4);
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(disk.owned_directrix, Some(OwnedDirectrix::Segments(disk.segments.clone())));
    let source = disk.source.as_ref().unwrap();
    assert_eq!(source.capture_status, AnalyticStatus::Complete);
    assert_eq!(source.records[&4].attributes["InnerRadius"], SourceValue::Real(0.25));
    assert_eq!(source.records[&3].attributes["Points"],
        SourceValue::List(vec![SourceValue::EntityRef(1), SourceValue::EntityRef(2)]));
}

/// Two trimmed lines and a reversed polyline, swept over a solid-level
/// interval; the walk goes through `CurveWalk::composite_trimmed`.
const TRIMMED_COMPOSITE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n\
#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(10.)),.T.,.PARAMETER.);\n\
#6=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);\n\
#7=IFCCARTESIANPOINT((10.,0.,0.));\n#8=IFCCARTESIANPOINT((10.,5.,0.));\n\
#9=IFCPOLYLINE((#8,#7));\n#10=IFCCOMPOSITECURVESEGMENT(.DISCONTINUOUS.,.F.,#9);\n\
#11=IFCCOMPOSITECURVE((#6,#10),.F.);\n#12=IFCSWEPTDISKSOLID(#11,1.,$,5.,12.);";

#[test]
fn trimmed_composite_directrix_keeps_every_segment_transition_sense_and_parent() {
    let disk = disk(TRIMMED_COMPOSITE, 12);
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(disk.segments.len(), 2, "solid interval is still applied");
    let source = disk.source.as_ref().unwrap();
    assert_eq!(source.capture_status, AnalyticStatus::Complete);
    assert_eq!(
        source.records[&11].attributes["Segments"],
        SourceValue::List(vec![SourceValue::EntityRef(6), SourceValue::EntityRef(10)])
    );
    for (id, transition, same_sense, parent) in
        [(6, "CONTINUOUS", "T", 5), (10, "DISCONTINUOUS", "F", 9)]
    {
        let segment = &source.records[&id];
        assert_eq!(segment.ifc_type_name, "IfcCompositeCurveSegment");
        assert_eq!(segment.attributes["Transition"], SourceValue::Enum(transition.into()));
        assert_eq!(segment.attributes["SameSense"], SourceValue::Enum(same_sense.into()));
        assert_eq!(segment.attributes["ParentCurve"], SourceValue::EntityRef(parent));
        assert!(source.records.contains_key(&parent));
    }
}

#[test]
fn refused_composite_still_captures_every_remaining_segment() {
    // The first segment's B-spline parent is not line/arc, so interpretation
    // refuses the composite; the captured source must not stop there.
    let data = RATIONAL.replace(
        "#7=IFCSWEPTDISKSOLID(#4,0.1,$,3.5,4.5);",
        "#7=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#4);\n\
#8=IFCPOLYLINE((#3,#5));\n#9=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#8);\n\
#10=IFCCOMPOSITECURVE((#7,#9),.F.);\n#11=IFCSWEPTDISKSOLID(#10,0.1,$,$,$);\n\
#12=IFCSWEPTDISKSOLID(#10,0.1,$,0.,5.);",
    );
    for solid in [11, 12] {
        let disk = disk(&data, solid);
        assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
        assert!(disk.owned_directrix.is_none());
        let source = disk.source.as_ref().unwrap();
        assert_eq!(source.capture_status, AnalyticStatus::Complete);
        for id in [10, 7, 4, 9, 8] {
            assert!(source.records.contains_key(&id), "solid #{solid}: record #{id}");
        }
    }
}

#[test]
fn default_extraction_captures_no_source_and_keeps_interpretation() {
    for (data, id) in [(RATIONAL, 7), (TRIMMED_COMPOSITE, 12)] {
        let plain = disk_in(data, id, false);
        assert!(plain.source.is_none());
        assert!(plain.owned_directrix.is_none());
        let captured = disk_in(data, id, true);
        assert!(captured.source.is_some());
        assert_eq!(plain.segments, captured.segments, "capture never changes geometry");
        assert_eq!(plain.status, captured.status);
        assert_eq!((plain.start_param, plain.end_param), (captured.start_param, captured.end_param));
    }
    assert!(!source::requested(), "the scope is closed after use");
}
