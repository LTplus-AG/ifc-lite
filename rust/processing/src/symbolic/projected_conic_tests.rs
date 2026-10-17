// SPDX-License-Identifier: MPL-2.0
//! #7779 P2: assert emitted geometry through the public symbolic entry point.
use super::{extract_symbolic_data, SymbolicData};

const SOURCE: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'P',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('FootPrint','Model',*,*,*,*,#10,$,.PLAN_VIEW.,$);
#20=IFCDIRECTION((0.,-0.8660254037844386,0.5));
#21=IFCAXIS2PLACEMENT3D(#12,#20,$);
#22=IFCLOCALPLACEMENT($,#21);
#30=IFCAXIS2PLACEMENT2D(#31,$);
#31=IFCCARTESIANPOINT((0.,0.));
#32=IFCCIRCLE(#30,1.);
#40=IFCSHAPEREPRESENTATION(#13,'FootPrint','Curve2D',(#32));
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#40));
#50=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Tilted circle',$,$,#22,#41);
ENDSEC;
END-ISO-10303-21;
"#;

fn bounds(data: &SymbolicData) -> [f32; 4] {
    let mut bounds = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for line in &data.polylines {
        for xy in line.points.chunks_exact(2) {
            bounds[0] = bounds[0].min(xy[0]);
            bounds[1] = bounds[1].min(xy[1]);
            bounds[2] = bounds[2].max(xy[0]);
            bounds[3] = bounds[3].max(xy[1]);
        }
    }
    for fill in &data.fills {
        for xy in fill.points.chunks_exact(2) {
            bounds[0] = bounds[0].min(xy[0]);
            bounds[1] = bounds[1].min(xy[1]);
            bounds[2] = bounds[2].max(xy[0]);
            bounds[3] = bounds[3].max(xy[1]);
        }
    }
    for circle in &data.circles {
        bounds[0] = bounds[0].min(circle.center_x - circle.radius);
        bounds[1] = bounds[1].min(circle.center_y - circle.radius);
        bounds[2] = bounds[2].max(circle.center_x + circle.radius);
        bounds[3] = bounds[3].max(circle.center_y + circle.radius);
    }
    bounds
}

fn assert_bounds(data: &SymbolicData, expected: [f32; 4]) {
    for (got, want) in bounds(data).into_iter().zip(expected) {
        assert!((got - want).abs() < 0.002, "bounds {:?}, expected {expected:?}", bounds(data));
    }
}

#[test]
fn issue_7779_tilted_circle_emits_foreshortened_curve_and_edge_on_line() {
    for (axis, half_y) in [("0.,-0.8660254037844386,0.5", 0.5), ("0.,-1.,0.", 0.0)] {
        let source = SOURCE.replace("0.,-0.8660254037844386,0.5", axis);
        let data = extract_symbolic_data(&source);
        assert_bounds(&data, [-1., -half_y, 1., half_y]);
        assert!(data.circles.is_empty(), "a projected ellipse/line cannot carry one radius");
        assert_eq!(data.polylines.len(), 1);
        assert!(data.polylines[0].closed);
        // Every emitted point lies on the projected unit circle (or its line).
        for xy in data.polylines[0].points.chunks_exact(2) {
            if half_y > 0. {
                assert!((xy[0].powi(2) + (xy[1] / half_y).powi(2) - 1.).abs() < 1e-5);
            } else {
                assert_eq!(xy[1], 0.);
            }
        }
    }
}

#[test]
fn issue_7779_similarity_control_keeps_an_exact_native_circle() {
    let source = SOURCE.replace("0.,-0.8660254037844386,0.5", "0.,0.,1.");
    let data = extract_symbolic_data(&source);
    assert_eq!(data.circles.len(), 1);
    assert!(data.polylines.is_empty());
    assert_eq!(data.circles[0].radius, 1.);
    assert_bounds(&data, [-1., -1., 1., 1.]);
}

#[test]
fn issue_7779_conic_position_tilt_and_trimmed_arcs_preserve_projected_points() {
    let circle_position = SOURCE.replace("#22=IFCLOCALPLACEMENT($,#21)", "#22=IFCLOCALPLACEMENT($,#11)")
        .replace("#30=IFCAXIS2PLACEMENT2D(#31,$)", "#30=IFCAXIS2PLACEMENT3D(#12,#20,$)");
    assert_bounds(&extract_symbolic_data(&circle_position), [-1., -0.5, 1., 0.5]);
    // The reachable arc consumer already samples; protect it from scalar-radius substitution.
    for source in [SOURCE.to_string(), circle_position] {
        let source = source.replace("(#32));", "(#33));")
            .replace("#40=", "#33=IFCTRIMMEDCURVE(#32,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);\n#40=");
        let data = extract_symbolic_data(&source);
        assert!(data.circles.is_empty());
        assert_eq!(data.polylines.len(), 1);
        assert!(!data.polylines[0].closed);
        assert_bounds(&data, [0., -0.5, 1., 0.]);
    }
}

const OPPOSED_TILTS: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'P',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('FootPrint','Model',*,*,*,*,#10,$,.PLAN_VIEW.,$);
#20=IFCDIRECTION((0.,-0.8660254037844386,0.5));
#21=IFCAXIS2PLACEMENT3D(#12,#20,$);
#22=IFCLOCALPLACEMENT($,#21);
#29=IFCDIRECTION((0.,0.8660254037844386,0.5));
#30=IFCAXIS2PLACEMENT3D(#12,#29,$);
#31=IFCCARTESIANPOINT((0.,0.));
#32=IFCCIRCLE(#30,1.);
#40=IFCSHAPEREPRESENTATION(#10,'FootPrint','Curve3D',(#32));
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#40));
#50=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Tilted circle',$,$,#22,#41);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn issue_7779_opposed_product_and_conic_tilts_compose_before_projection() {
    // Rx(+60) * Rx(-60) = identity in 3D. Projecting first instead gives
    // diag(1, .5) * diag(1, .5), a quarter-height ellipse (#7779).
    let circle = extract_symbolic_data(OPPOSED_TILTS);
    assert_bounds(&circle, [-1., -1., 1., 1.]);
    assert_eq!(circle.circles.len(), 1, "the resulting world curve IS a circle");
    assert!((circle.circles[0].radius - 1.).abs() < 1e-6);
    let ellipse = OPPOSED_TILTS.replace("IFCCIRCLE(#30,1.)", "IFCELLIPSE(#30,2.,1.)");
    assert_bounds(&extract_symbolic_data(&ellipse), [-2., -1., 2., 1.]);
    let arc = OPPOSED_TILTS.replace("(#32));", "(#33));")
        .replace("#40=", "#33=IFCTRIMMEDCURVE(#32,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);\n#40=");
    assert_bounds(&extract_symbolic_data(&arc), [0., -1., 1., 0.]);
}

#[test]
fn issue_7779_conic_position_z_is_carried_through_the_product_tilt() {
    let source = SOURCE.replace("#30=IFCAXIS2PLACEMENT2D(#31,$)", "#30=IFCAXIS2PLACEMENT3D(#34,$,$);#34=IFCCARTESIANPOINT((0.,0.,2.))");
    let data = extract_symbolic_data(&source);
    let center_y = 3_f32.sqrt(); // plan Y flip of -2*sin(60)
    assert_bounds(&data, [-1., center_y - 0.5, 1., center_y + 0.5]);
}

#[test]
fn issue_7779_cartesian_arc_trims_use_the_unprojected_conic_frame() {
    let source = OPPOSED_TILTS.replace("(#32));", "(#33));")
        .replace("#40=", "#35=IFCCARTESIANPOINT((1.,0.,0.));#36=IFCCARTESIANPOINT((0.7071067811865476,0.3535533905932738,-0.6123724356957945));#33=IFCTRIMMEDCURVE(#32,(#35),(#36),.T.,.CARTESIAN.);\n#40=");
    let data = extract_symbolic_data(&source);
    assert_eq!(data.polylines.len(), 1);
    assert_bounds(&data, [std::f32::consts::FRAC_1_SQRT_2, -std::f32::consts::FRAC_1_SQRT_2, 1., 0.]);
}

#[test]
fn issue_7779_small_context_tilt_keeps_its_full_3d_coupling() {
    // A tiny WCS rotation is not identity: with a large conic Z translation
    // its off-plane term moves the final plan center by ten metres (#7779).
    let source = SOURCE.replace("3,1.E-5,#11,$", "3,1.E-5,#21,$")
        .replace("#22=IFCLOCALPLACEMENT($,#21)", "#22=IFCLOCALPLACEMENT($,#11)")
        .replace("0.,-0.8660254037844386,0.5", "0.,-0.00001,0.99999999995")
        .replace("#30=IFCAXIS2PLACEMENT2D(#31,$)", "#30=IFCAXIS2PLACEMENT3D(#34,$,$);#34=IFCCARTESIANPOINT((0.,0.,1000000.))")
        .replace("#13,'FootPrint','Curve2D'", "#10,'FootPrint','Curve3D'");
    assert_bounds(&extract_symbolic_data(&source), [-1., 9., 1., 11.]);
}

fn filled(source: &str) -> String {
    source.replace("(#32));", "(#33));")
        .replace("#40=", "#33=IFCANNOTATIONFILLAREA(#32,(#35));#35=IFCCIRCLE(#30,0.5);\n#40=")
}

#[test]
fn issue_7779_conic_fill_boundaries_compose_outer_and_hole_frames_in_3d() {
    for (source, expected) in [
        (OPPOSED_TILTS.to_string(), [-1., -1., 1., 1.]),
        (OPPOSED_TILTS.replace("IFCCIRCLE(#30,1.)", "IFCELLIPSE(#30,2.,1.)"), [-2., -1., 2., 1.]),
        (SOURCE.to_string(), [-1., -0.5, 1., 0.5]),
        (SOURCE.replace("0.,-0.8660254037844386,0.5", "0.,0.,1."), [-1., -1., 1., 1.]),
        (SOURCE.replace("0.,-0.8660254037844386,0.5", "0.,-1.,0."), [-1., 0., 1., 0.]),
    ] {
        let data = extract_symbolic_data(&filled(&source));
        assert_eq!(data.fills.len(), 1);
        assert_bounds(&data, expected);
        let fill = &data.fills[0];
        assert_eq!(fill.holes_offsets, [64]);
        // Hole shares the authored conic frame; it must have half the outer
        // unit-circle's projected Y extent, including after cancelling tilts.
        let hole = &fill.points[128..];
        let high_y = hole.chunks_exact(2).map(|xy| xy[1]).fold(f32::NEG_INFINITY, f32::max);
        assert!((high_y - expected[3] * 0.5).abs() < 0.002);
    }
}

#[test]
fn issue_7779_conic_fill_center_elevation_uses_the_composed_3d_frame() {
    let source = SOURCE.replace("#30=IFCAXIS2PLACEMENT2D(#31,$)", "#30=IFCAXIS2PLACEMENT3D(#34,$,$);#34=IFCCARTESIANPOINT((0.,0.,2.))");
    let data = extract_symbolic_data(&filled(&source));
    assert_bounds(&data, [-1., 3_f32.sqrt() - 0.5, 1., 3_f32.sqrt() + 0.5]);
    assert_eq!(data.fills.len(), 1);
    assert!((data.fills[0].world_y - 1.).abs() < 1e-6);
}

fn mapped(source: &str, origin: &str, target: &str) -> String {
    source.replace("#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#40));", &format!(
        "#90=IFCCARTESIANPOINT((0.,0.,0.));#91=IFCDIRECTION((1.,0.,0.));#92=IFCDIRECTION((0.,1.,0.));\n#93={target};#94=IFCREPRESENTATIONMAP({origin},#40);#95=IFCMAPPEDITEM(#94,#93);#96=IFCSHAPEREPRESENTATION(#10,'FootPrint','MappedRepresentation',(#95));#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#96));"))
}

#[test]
fn issue_7779_mapped_target_opposed_tilts_compose_before_projection() {
    let source = OPPOSED_TILTS.replace("IFCCIRCLE(#30,1.)", "IFCCIRCLE(#11,1.)");
    let target = "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#91,#97,#90,1.,#98);#97=IFCDIRECTION((0.,0.5,-0.8660254037844386));#98=IFCDIRECTION((0.,0.8660254037844386,0.5))";
    let source = mapped(&source, "#11", target);
    let data = extract_symbolic_data(&source);
    assert_bounds(&data, [-1., -1., 1., 1.]);
    assert_eq!(data.circles.len(), 1);
    // The same target applies to all reachable conic consumers.
    assert_bounds(&extract_symbolic_data(&source.replace("IFCCIRCLE(#11,1.)", "IFCELLIPSE(#11,2.,1.)")), [-2., -1., 2., 1.]);
    assert_bounds(&extract_symbolic_data(&filled(&source)), [-1., -1., 1., 1.]);
}

#[test]
fn issue_7779_mapped_origin_tiny_tilt_is_not_discarded_before_large_z_composition() {
    let source = SOURCE.replace("#22=IFCLOCALPLACEMENT($,#21)", "#22=IFCLOCALPLACEMENT($,#11)")
        .replace("0.,-0.8660254037844386,0.5", "0.,-0.00001,0.99999999995")
        .replace("#30=IFCAXIS2PLACEMENT2D(#31,$)", "#30=IFCAXIS2PLACEMENT3D(#34,$,$);#34=IFCCARTESIANPOINT((0.,0.,1000000.))");
    let source = mapped(&source, "#21", "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#90,$,$)");
    assert_bounds(&extract_symbolic_data(&source), [-1., 9., 1., 11.]);
}

#[test]
fn issue_7779_mapped_units_scale_target_and_origin_once() {
    let source = SOURCE.replace("0.,-0.8660254037844386,0.5", "0.,0.,1.")
        .replace("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)")
        .replace("#31=IFCCARTESIANPOINT((0.,0.))", "#31=IFCCARTESIANPOINT((30.,0.))")
        .replace("#40=", "#97=IFCAXIS2PLACEMENT3D(#98,$,$);#98=IFCCARTESIANPOINT((10.,0.,0.));\n#40=");
    let source = mapped(&source, "#97", "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#90,2.,$)")
        .replace("#90=IFCCARTESIANPOINT((0.,0.,0.))", "#90=IFCCARTESIANPOINT((100.,0.,0.))");
    let data = extract_symbolic_data(&source);
    assert_eq!(data.circles.len(), 1);
    assert!((data.circles[0].center_x - 0.18).abs() < 1e-6);
    assert!((data.circles[0].radius - 0.002).abs() < 1e-6);
}

#[test]
fn issue_7779_mapped_target_canonical_defaults_reflection_signed_and_nonuniform_scale() {
    let source = SOURCE.replace("0.,-0.8660254037844386,0.5", "0.,0.,1.")
        .replace("#31=IFCCARTESIANPOINT((0.,0.))", "#31=IFCCARTESIANPOINT((1.,2.))");
    for (target, expected, circles) in [
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#90,$)", [0., -3., 2., -1.], 1),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2D(#91,#97,#90,1.);#97=IFCDIRECTION((0.,-1.))", [0., 1., 2., 3.], 1),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#90,-2.,$)", [-4., 2., 0., 6.], 1),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#90,2.,3.)", [0., -9., 4., -3.], 0),
    ] {
        let data = extract_symbolic_data(&mapped(&source, "#11", target));
        assert_bounds(&data, expected);
        assert_eq!(data.circles.len(), circles, "{target}");
    }
    for target in ["IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,1.,$)", "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#90,$,#90,1.,$)"] {
        let data = extract_symbolic_data(&mapped(&source, "#11", target));
        assert!(data.circles.is_empty() && data.polylines.is_empty() && data.fills.is_empty(), "malformed canonical operator must drop: {target}");
    }
}
