// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityDecoder;

#[test]
fn indexed_arc_stays_in_its_authored_plane() {
    let data = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(10.,0.,10.),(20.,0.,0.)));\n#2=IFCINDEXEDPOLYCURVE(#1,(IFCARCINDEX((1,2,3))),.F.);\n#3=IFCSWEPTDISKSOLID(#2,1.,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(3).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    let AnalyticCurveSegment::Arc {
        center,
        normal,
        radius,
        sweep_angle,
        ..
    } = &disk.segments[0]
    else {
        panic!("expected arc");
    };
    assert!((center[0] - 10.0).abs() < 1e-9);
    assert!((center[2]).abs() < 1e-9);
    assert!((normal[1].abs() - 1.0).abs() < 1e-9);
    assert!((*radius - 10.0).abs() < 1e-9);
    assert!((sweep_angle.abs() - std::f64::consts::PI).abs() < 1e-9);
}

#[test]
fn composite_reverse_preserves_order() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCCARTESIANPOINT((1.,0.,0.));\n#3=IFCCARTESIANPOINT((2.,0.,0.));\n#4=IFCPOLYLINE((#2,#3));\n#5=IFCPOLYLINE((#1,#2));\n#6=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#4);\n#7=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#5);\n#8=IFCCOMPOSITECURVE((#6,#7),.F.);\n#9=IFCSWEPTDISKSOLID(#8,0.1,$,0.,2.);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(9).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(
        disk.segments,
        vec![
            AnalyticCurveSegment::Line {
                start: [2.0, 0.0, 0.0],
                end: [1.0, 0.0, 0.0]
            },
            AnalyticCurveSegment::Line {
                start: [1.0, 0.0, 0.0],
                end: [0.0, 0.0, 0.0]
            },
        ]
    );
}

#[test]
fn circular_trim_handles_degree_units_and_xz_placement() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,-1.,0.));\n#3=IFCDIRECTION((1.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n#5=IFCCIRCLE(#4,2.);\n#6=IFCTRIMMEDCURVE(#5,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);\n#7=IFCSWEPTDISKSOLID(#6,0.1,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(7).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    let AnalyticCurveSegment::Arc {
        normal,
        radius,
        sweep_angle,
        ..
    } = &disk.segments[0]
    else {
        panic!("expected arc");
    };
    assert_eq!(*normal, [0.0, -1.0, 0.0]);
    assert_eq!(*radius, 2.0);
    assert!((sweep_angle - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
}

#[test]
fn cyclic_composite_is_reported() {
    let data = "#1=IFCCOMPOSITECURVE((#2),.F.);\n#2=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#1);\n#3=IFCSWEPTDISKSOLID(#1,1.,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(3).unwrap();
    assert!(extract_swept_disk(&entity, &mut decoder).is_err());
}

#[test]
fn issue_1348_ubar_uses_sum_of_parent_parameter_spans() {
    let data = include_str!("../../tests/fixtures/swept_disk_composite_arc_ubar.ifc");
    let index = ifc_lite_core::build_entity_index(data);
    let mut decoder = EntityDecoder::with_index(data, index);
    let entity = decoder.decode_by_id(72).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(disk.segments.len(), 5);
    assert_eq!(
        disk.segments
            .iter()
            .filter(|p| matches!(p, AnalyticCurveSegment::Arc { .. }))
            .count(),
        2
    );
    for segment in &disk.segments {
        if let AnalyticCurveSegment::Arc { normal, .. } = segment {
            assert!(normal[1].abs() > 0.99, "bend must remain in the XZ plane");
        }
    }
}

#[test]
fn unbounded_line_cannot_be_reported_as_a_finite_directrix() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCSWEPTDISKSOLID(#4,1.,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(5).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
    assert!(disk.segments.is_empty());
}

#[test]
fn raw_circle_is_closed_and_missing_ref_direction_uses_canonical_frame() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCAXIS2PLACEMENT3D(#1,#2,$);\n#4=IFCCIRCLE(#3,2.);\n#5=IFCSWEPTDISKSOLID(#4,0.1,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(5).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    let AnalyticCurveSegment::Arc {
        normal,
        x_axis,
        sweep_angle,
        ..
    } = &disk.segments[0]
    else {
        panic!("expected circle");
    };
    assert_eq!(*normal, [1.0, 0.0, 0.0]);
    assert!(x_axis.iter().all(|n| n.is_finite()));
    assert!((sweep_angle - std::f64::consts::TAU).abs() < 1e-9);
}

#[test]
fn reversed_trimmed_line_keeps_authored_trim_order() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(10.)),(IFCPARAMETERVALUE(2.)),.F.,.PARAMETER.);\n#6=IFCSWEPTDISKSOLID(#5,1.,$,$,$);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(6).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(
        disk.segments,
        vec![AnalyticCurveSegment::Line {
            start: [10.0, 0.0, 0.0],
            end: [2.0, 0.0, 0.0]
        }]
    );
}

#[test]
fn trimmed_line_solid_bounds_must_be_relative_to_trimmed_domain() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(2.)),(IFCPARAMETERVALUE(5.)),.T.,.PARAMETER.);\n#6=IFCSWEPTDISKSOLID(#5,1.,$,0.,3.);\n#7=IFCSWEPTDISKSOLID(#5,1.,$,2.,5.);";
    let mut decoder = EntityDecoder::new(data);
    let redundant = decoder.decode_by_id(6).unwrap();
    let basis_parameters = decoder.decode_by_id(7).unwrap();
    assert_eq!(
        extract_swept_disk(&redundant, &mut decoder).unwrap().status,
        AnalyticStatus::Complete
    );
    let disk = extract_swept_disk(&basis_parameters, &mut decoder).unwrap();
    assert!(matches!(disk.status, AnalyticStatus::Unsupported(_)));
    assert!(disk.segments.is_empty());
}

#[test]
fn repeated_curve_fanout_is_bounded_before_materializing_unlimited_output() {
    let point_entities = (1..=101)
        .map(|i| format!("#{i}=IFCCARTESIANPOINT(({},0.,0.));", i - 1))
        .collect::<Vec<_>>();
    let point_refs = (1..=101)
        .map(|i| format!("#{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let segments = (0..1_100).map(|_| "#103").collect::<Vec<_>>().join(",");
    let data = format!("{}\n#102=IFCPOLYLINE(({point_refs}));\n#103=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#102);\n#104=IFCCOMPOSITECURVE(({segments}),.F.);\n#105=IFCSWEPTDISKSOLID(#104,1.,$,$,$);", point_entities.join("\n"));
    let index = ifc_lite_core::build_entity_index(&data);
    let mut decoder = EntityDecoder::with_index(&data, index);
    let entity = decoder.decode_by_id(105).unwrap();
    assert!(extract_swept_disk(&entity, &mut decoder).is_err());
}

#[test]
fn composite_trim_uses_parent_parameter_spans_across_line_and_arc() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCDIRECTION((1.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(10.)),.T.,.PARAMETER.);\n#6=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);\n#7=IFCCARTESIANPOINT((10.,2.));\n#8=IFCAXIS2PLACEMENT2D(#7,$);\n#9=IFCCIRCLE(#8,2.);\n#10=IFCTRIMMEDCURVE(#9,(IFCPARAMETERVALUE(-1.5707963267948966)),(IFCPARAMETERVALUE(0.)),.T.,.PARAMETER.);\n#11=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#10);\n#12=IFCCOMPOSITECURVE((#6,#11),.F.);\n#13=IFCSWEPTDISKSOLID(#12,0.5,$,5.,10.785398163397448);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(13).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(disk.segments.len(), 2);
    assert_eq!(
        disk.segments[0],
        AnalyticCurveSegment::Line {
            start: [5.0, 0.0, 0.0],
            end: [10.0, 0.0, 0.0]
        }
    );
    let AnalyticCurveSegment::Arc {
        start_angle,
        sweep_angle,
        ..
    } = &disk.segments[1]
    else {
        panic!("expected bend");
    };
    assert!((start_angle + std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert!((sweep_angle - std::f64::consts::FRAC_PI_4).abs() < 1e-9);
}

#[test]
fn raw_circle_solid_bounds_select_exact_arc_and_keep_inner_radius() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCAXIS2PLACEMENT2D(#1,$);\n#3=IFCCIRCLE(#2,20.);\n#4=IFCSWEPTDISKSOLID(#3,16.7,12.15,0.,0.79);";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(4).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(disk.inner_radius, Some(12.15));
    let AnalyticCurveSegment::Arc {
        radius,
        start_angle,
        sweep_angle,
        ..
    } = &disk.segments[0]
    else {
        panic!("expected trimmed circle");
    };
    assert_eq!(*radius, 20.0);
    assert_eq!(*start_angle, 0.0);
    assert!((sweep_angle - 0.79).abs() < 1e-12);
}

#[test]
fn typed_solid_bounds_and_radii_preserve_line_extent() {
    // STEP typed values are common in exported IFC. A typed StartParam must
    // limit the line just like the equivalent bare numeric attribute.
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCSWEPTDISKSOLID(#4,IFCPOSITIVELENGTHMEASURE(2.),IFCPOSITIVELENGTHMEASURE(1.),IFCPARAMETERVALUE(2.),IFCPARAMETERVALUE(5.));";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(5).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!((disk.radius, disk.inner_radius), (2.0, Some(1.0)));
    assert_eq!(
        disk.segments,
        vec![AnalyticCurveSegment::Line {
            start: [2.0, 0.0, 0.0],
            end: [5.0, 0.0, 0.0]
        }]
    );
}

#[test]
fn typed_solid_bounds_select_circle_arc() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCAXIS2PLACEMENT2D(#1,$);\n#3=IFCCIRCLE(#2,20.);\n#4=IFCSWEPTDISKSOLID(#3,1.,$,IFCPARAMETERVALUE(0.25),IFCPARAMETERVALUE(0.79));";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(4).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    let AnalyticCurveSegment::Arc {
        start_angle,
        sweep_angle,
        ..
    } = &disk.segments[0]
    else {
        panic!("expected arc");
    };
    assert!((*start_angle - 0.25).abs() < 1e-12);
    assert!((*sweep_angle - 0.54).abs() < 1e-12);
}

#[test]
fn typed_solid_bounds_select_composite_parent_domain() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(10.)),.T.,.PARAMETER.);\n#6=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);\n#7=IFCCARTESIANPOINT((10.,0.,0.));\n#8=IFCLINE(#7,#3);\n#9=IFCTRIMMEDCURVE(#8,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(10.)),.T.,.PARAMETER.);\n#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9);\n#11=IFCCOMPOSITECURVE((#6,#10),.F.);\n#12=IFCSWEPTDISKSOLID(#11,1.,$,IFCPARAMETERVALUE(5.),IFCPARAMETERVALUE(15.));";
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(12).unwrap();
    let disk = extract_swept_disk(&entity, &mut decoder).unwrap();
    assert_eq!(disk.status, AnalyticStatus::Complete);
    assert_eq!(
        disk.segments,
        vec![
            AnalyticCurveSegment::Line {
                start: [5.0, 0.0, 0.0],
                end: [10.0, 0.0, 0.0]
            },
            AnalyticCurveSegment::Line {
                start: [10.0, 0.0, 0.0],
                end: [15.0, 0.0, 0.0]
            },
        ]
    );
}

#[test]
fn malformed_present_typed_measure_is_an_error() {
    let data = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n#4=IFCLINE(#1,#3);\n#5=IFCSWEPTDISKSOLID(#4,1.,$,IFCPARAMETERVALUE('bad'),IFCPARAMETERVALUE(5.));\n#6=IFCSWEPTDISKSOLID(#4,1.,IFCPOSITIVELENGTHMEASURE('bad'),IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(5.));";
    let mut decoder = EntityDecoder::new(data);
    for id in [5, 6] {
        let entity = decoder.decode_by_id(id).unwrap();
        assert!(
            extract_swept_disk(&entity, &mut decoder).is_err(),
            "malformed typed measure at #{id} was treated as absent"
        );
    }
}
