// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn model(prefix: &str, extra: &str) -> String {
    format!(
        "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10000.,0.,1000.));
#12=IFCPOLYLINE((#10,#11));
#20=IFCALIGNMENT('a',$,'Road',$,$,$,$,#12);
{extra} ENDSEC;END-ISO-10303-21;"
    )
}
fn near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-8, "{actual} != {expected}");
}

#[test]
fn issue_6600_mm_grade_endpoints_and_finite_unit_tangents() {
    let report = sample_alignment_axes(
        &model(".MILLI.", ""),
        AlignmentSamplingOptions {
            spacing_m: 3.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(report.diagnostics.is_empty());
    let axis = &report.axes[0];
    near(axis.geometric_horizontal_length_m, 10.0);
    assert_eq!(axis.Name.as_deref(), Some("Road"));
    assert_eq!(axis.samples.len(), 5);
    assert_eq!(
        axis.samples
            .iter()
            .map(|s| s.geometric_horizontal_distance_m)
            .collect::<Vec<_>>(),
        [0., 3., 6., 9., 10.]
    );
    assert_eq!(axis.samples.last().unwrap().point, [10., 0., 1.]);
    for sample in &axis.samples {
        near(sample.tangent.iter().map(|v| v * v).sum::<f64>(), 1.0);
        near(sample.tangent[2] / sample.tangent[0], 0.1);
    }
}

#[test]
fn issue_6600_total_and_axis_bounds_report_coarsening_and_omission() {
    let content = model(
        "$",
        "#21=IFCALIGNMENT('b',$,'Second',$,$,$,$,#12);#22=IFCALIGNMENT('c',$,'Third',$,$,$,$,#12);",
    );
    let options = AlignmentSamplingOptions {
        spacing_m: f64::MIN_POSITIVE,
        max_samples_per_axis: 3,
        max_total_samples: 5,
    };
    let report = sample_alignment_axes(&content, options).unwrap();
    assert_eq!(report.axes.len(), 2);
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(20)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::AxisSampleLimit)));
    assert!(!report.diagnostics.iter().any(|d| d.express_id == Some(20)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::TotalSampleLimit)));
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(21)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::TotalSampleLimit)));
    assert!(!report.diagnostics.iter().any(|d| d.express_id == Some(21)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::AxisSampleLimit)));
    assert_eq!(
        report.axes.iter().map(|a| a.samples.len()).sum::<usize>(),
        5
    );
    for axis in &report.axes {
        assert_eq!(axis.samples[0].geometric_horizontal_distance_m, 0.0);
        assert_eq!(
            axis.samples.last().unwrap().geometric_horizontal_distance_m,
            10000.0
        );
    }
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(22)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::TotalSampleLimit)));
}

#[test]
fn issue_6600_strict_units_placement_and_vertical_polyline_report_failure() {
    let cases = [
        model("$", "").replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);", ""),
        model("$", "").replace("'Road',$,$,$,$,#12", "'Road',$,$,#999,$,#12"),
        model("$", "").replace("10000.,0.,1000.", "0.,0.,1000."),
    ];
    for content in cases {
        let report = sample_alignment_axes(&content, Default::default()).unwrap();
        assert!(report.axes.is_empty());
        assert!(!report.diagnostics.is_empty());
    }
    assert!(sample_alignment_axes(
        &model("$", ""),
        AlignmentSamplingOptions {
            spacing_m: 0.0,
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn issue_6600_scaled_rotated_placement_is_absolute_ifc_z_up() {
    let content = model(".MILLI.", "#30=IFCCARTESIANPOINT((20000.,30000.,40000.));#31=IFCDIRECTION((0.,1.,0.));#32=IFCAXIS2PLACEMENT3D(#30,$,#31);#33=IFCLOCALPLACEMENT($,#32);")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,#33,$,#12");
    let report = sample_alignment_axes(&content, Default::default()).unwrap();
    assert!(report.diagnostics.is_empty());
    let samples = &report.axes[0].samples;
    assert_eq!(samples[0].point, [20., 30., 40.]);
    assert_eq!(samples.last().unwrap().point, [20., 40., 41.]);
    near(samples[0].tangent[0], 0.0);
    assert!(samples[0].tangent[1] > 0.99);
}

#[test]
fn issue_6600_real_infrastructure_axes_have_distinct_identity_and_bounded_endpoints() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/issues/844_terrain_and_alignment.ifc");
    let Ok(content) = std::fs::read_to_string(path) else {
        eprintln!("SKIP: run pnpm fixtures for infrastructure model844");
        return;
    };
    let report = sample_alignment_axes(
        &content,
        AlignmentSamplingOptions {
            spacing_m: 5.,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        report.axes.iter().map(|a| a.express_id).collect::<Vec<_>>(),
        [39, 59, 114, 134, 161]
    );
    for axis in &report.axes {
        assert_eq!(axis.samples[0].geometric_horizontal_distance_m, 0.);
        near(
            axis.samples.last().unwrap().geometric_horizontal_distance_m,
            axis.geometric_horizontal_length_m,
        );
        assert!(axis.samples.len() <= 5001);
        for s in &axis.samples {
            assert!(s.point.iter().all(|v| v.is_finite()));
            near(s.tangent.iter().map(|v| v * v).sum(), 1.);
        }
    }
}

#[test]
fn issue_6600_authored_chainage_does_not_change_geometric_distance() {
    let content = model("$", "#36=IFCCARTESIANPOINT((0.,0.));#30=IFCLINESEGMENT2D(#36,0.,100.);#31=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#30);#32=IFCALIGNMENT2DHORIZONTAL(1000.,(#31));#33=IFCALIGNMENT2DVERSEGLINE($,$,$,1000.,100.,50.,0.1);#34=IFCALIGNMENT2DVERTICAL((#33));#35=IFCALIGNMENTCURVE(#32,#34,$);")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,$,#35");
    let axis = AlignmentAxis::from_content(&content, 20).unwrap();
    assert_eq!(axis.length_m(), 100.);
    assert_eq!(axis.evaluate(50.).unwrap().point, [50., 0., 55.]);
    assert!(axis.evaluate(1000.).is_err());
    assert!(axis.evaluate(f64::NAN).is_err());
}

#[test]
fn issue_6600_real_circle_matches_analytic_heading_and_radius_oracle() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/issues/844_terrain_and_alignment.ifc");
    let Ok(content) = std::fs::read_to_string(path) else {
        eprintln!("SKIP: run pnpm fixtures for infrastructure model844");
        return;
    };
    // OIP2017 authoring fixture #43: CCW radius15.00004036907433,
    // start(0,0), heading5.246193083124705. A circular integration oracle
    // independent of the alignment evaluator, sampled inside the first segment.
    let radius: f64 = 15.00004036907433;
    let heading: f64 = 5.246193083124705;
    let axis = AlignmentAxis::from_content(&content, 39).unwrap();
    let p = axis.evaluate(10.).unwrap().point;
    near(
        p[0],
        radius * ((heading + 10. / radius).sin() - heading.sin()),
    );
    near(
        p[1],
        radius * (heading.cos() - (heading + 10. / radius).cos()),
    );
}

#[test]
fn issue_6600_diagnostic_output_is_bounded_and_reports_suppression() {
    let extra = (100..1200)
        .map(|id| format!("#{id}=IFCALIGNMENT('x',$,$,$,$,$,$,$);"))
        .collect::<String>();
    let report = sample_alignment_axes(&model("$", &extra), Default::default()).unwrap();
    assert_eq!(report.diagnostics.len(), MAX_DIAGNOSTICS);
    // The valid10000m axis also reports per-axis spacing coarsening.
    assert_eq!(report.diagnostics_omitted, 101);
}

#[test]
fn issue_6600_declared_invalid_placement_never_becomes_identity() {
    let valid = "#30=IFCCARTESIANPOINT((1.,2.,3.));#31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCLOCALPLACEMENT($,#31);";
    let content = model("$", valid).replace("'Road',$,$,$,$,#12", "'Road',$,$,#32,$,#12");
    for broken in [
        content.replace(
            "#32=IFCLOCALPLACEMENT($,#31)",
            "#32=IFCLOCALPLACEMENT(#32,#31)",
        ),
        content.replace(
            "#32=IFCLOCALPLACEMENT($,#31)",
            "#32=IFCLOCALPLACEMENT($,#30)",
        ),
        content.replace(
            "#31=IFCAXIS2PLACEMENT3D(#30,$,$)",
            "#31=IFCAXIS2PLACEMENT3D(#30,#30,$)",
        ),
        content.replace(
            "#31=IFCAXIS2PLACEMENT3D(#30,$,$)",
            "#31=IFCAXIS2PLACEMENT3D(#999,$,$)",
        ),
    ] {
        let report = sample_alignment_axes(&broken, Default::default()).unwrap();
        assert!(report.axes.is_empty());
        assert!(report.diagnostics.iter().any(|d| d.express_id == Some(20)
            && matches!(d.code, AlignmentSamplingDiagnosticCode::InvalidAxis)));
    }
    let chain = (100..210)
        .map(|id| format!("#{id}=IFCLOCALPLACEMENT(#{},#31);", id + 1))
        .collect::<String>();
    let long = content
        .replace(
            "#32=IFCLOCALPLACEMENT($,#31)",
            "#32=IFCLOCALPLACEMENT(#100,#31)",
        )
        .replace(
            "ENDSEC;END-ISO",
            &format!("{chain}#210=IFCLOCALPLACEMENT($,#31);ENDSEC;END-ISO"),
        );
    let report = sample_alignment_axes(&long, Default::default()).unwrap();
    assert!(report.axes.is_empty());
    assert!(report.diagnostics[0].message.contains("over-budget"));
}

#[test]
fn issue_6600_wrong_point_type_and_sparse_composite_fallback_are_not_complete_axes() {
    let content = model("$", "").replace("#11=IFCCARTESIANPOINT", "#11=IFCDIRECTION");
    assert!(sample_alignment_axes(&content, Default::default())
        .unwrap()
        .axes
        .is_empty());
    // The renderer can recover placement points for unsupported parents;
    // precise consumers must report the invalid axis rather than a chord.
    let composite = model("$", "#35=IFCCARTESIANPOINT((0.,0.));#30=IFCAXIS2PLACEMENT2D(#35,$);#31=IFCCURVESEGMENT(.CONTINUOUS.,#30,0.,10.,#999);#32=IFCCOMPOSITECURVE((#31),.F.);#33=IFCSHAPEREPRESENTATION($,'Axis',$,(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,#34,$");
    let report = sample_alignment_axes(&composite, Default::default()).unwrap();
    assert!(report.axes.is_empty());
    assert!(report.diagnostics[0]
        .message
        .contains("sparse fallback refused"));
}

#[test]
fn issue_6600_georeferenced_f64_and_tilt_preserve_local_horizontal_distance() {
    let content = model(".MILLI.", "#30=IFCCARTESIANPOINT((5000000000.,6000000000.,7000000000.));#31=IFCDIRECTION((0.,1.,0.));#32=IFCDIRECTION((1.,0.,0.));#33=IFCAXIS2PLACEMENT3D(#30,#32,#31);#34=IFCLOCALPLACEMENT($,#33);")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,#34,$,#12");
    let axis = AlignmentAxis::from_content(&content, 20).unwrap();
    assert_eq!(axis.length_m(), 10.);
    let sample = axis.evaluate(0.125).unwrap();
    // Local X rotates into worldY; localZ into worldX. Values remain f64,
    // before RTC. A rendererFloat32 conversion would lose this centimetre.
    near(sample.point[0], 5_000_000.012_5);
    near(sample.point[1], 6_000_000.125);
    near(sample.point[2], 7_000_000.);
}

#[test]
fn issue_6600_failed_frames_spend_the_total_sampling_work_budget() {
    let content = model("$", "#36=IFCCARTESIANPOINT((0.,0.));#30=IFCLINESEGMENT2D(#36,0.,100.);#31=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#30);#32=IFCALIGNMENT2DHORIZONTAL(0.,(#31));#33=IFCALIGNMENT2DVERSEGLINE($,$,$,0.,100.,1.E309,0.1);#34=IFCALIGNMENT2DVERTICAL((#33));#35=IFCALIGNMENTCURVE(#32,#34,$);#21=IFCALIGNMENT('b',$,$,$,$,$,$,#35);")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,$,#35");
    let report = sample_alignment_axes(
        &content,
        AlignmentSamplingOptions {
            max_total_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(report.axes.is_empty());
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(20)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::InvalidAxis)));
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(21)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::TotalSampleLimit)));
}

#[test]
fn issue_6600_ifc4x3_gradient_reports_tessellation_and_keeps_authored_grade() {
    let content = model("$", "#30=IFCCARTESIANPOINT((0.,0.));#31=IFCDIRECTION((1.,0.));#32=IFCAXIS2PLACEMENT2D(#30,#31);#33=IFCCIRCLE(#32,100.);#34=IFCCURVESEGMENT(.CONTINUOUS.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.07963267948966),#33);#35=IFCCOMPOSITECURVE((#34),.F.);#40=IFCCARTESIANPOINT((1000.,50.));#41=IFCDIRECTION((1.,0.1));#42=IFCAXIS2PLACEMENT2D(#40,#41);#43=IFCVECTOR(#31,1.);#44=IFCLINE(#30,#43);#45=IFCCURVESEGMENT(.CONTINUOUS.,#42,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.07963267948966),#44);#46=IFCGRADIENTCURVE((#45),.F.,#35,$);#47=IFCSHAPEREPRESENTATION($,'Axis',$,(#46));#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,#48,$").replace("IFC4X1", "IFC4X3");
    let axis = AlignmentAxis::from_content(&content, 20).unwrap();
    assert!(axis.approximate);
    assert!((157.07..157.08).contains(&axis.length_m()));
    assert_eq!(axis.evaluate(0.).unwrap().point, [0., 0., 50.]);
    let end = axis.evaluate(axis.length_m()).unwrap();
    assert!((end.point[0] - 100.).abs() < 1e-8);
    assert!((end.point[1] - 100.).abs() < 1e-8);
    near(end.point[2], 50. + axis.length_m() * 0.1);
    let report = sample_alignment_axes(&content, Default::default()).unwrap();
    assert!(report
        .diagnostics
        .iter()
        .any(|d| matches!(d.code, AlignmentSamplingDiagnosticCode::ApproximateCurve)));
}

#[test]
fn issue_6600_composite_cycle_with_a_valid_sibling_is_reported_not_truncated() {
    let content = model("$", "#30=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#12);#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#32);#32=IFCCOMPOSITECURVE((#30,#31),.F.);#33=IFCSHAPEREPRESENTATION($,'Axis',$,(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));")
        .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,#34,$");
    let report = sample_alignment_axes(&content, Default::default()).unwrap();
    assert!(report.axes.is_empty());
    assert!(report.diagnostics.iter().any(|d| d.express_id == Some(20)
        && matches!(d.code, AlignmentSamplingDiagnosticCode::InvalidAxis)
        && d.message.contains("Curve nesting depth")));
}
