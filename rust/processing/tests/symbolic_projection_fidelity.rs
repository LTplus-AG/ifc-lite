// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_processing::extract_symbolic_data;

fn fixture(axis: &str, items: &str, geometry: &str) -> String {
    format!(r#"ISO-10303-21;
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
#20=IFCDIRECTION(({axis}));
#21=IFCAXIS2PLACEMENT3D(#12,#20,$);
#22=IFCLOCALPLACEMENT($,#21);
{geometry}
#40=IFCSHAPEREPRESENTATION(#10,'FootPrint','Curve3D',({items}));
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#40));
#50=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Projection',$,$,#22,#41);
ENDSEC;
END-ISO-10303-21;
"#)
}

fn center_y(points: &[f32]) -> f32 {
    let min = points.chunks_exact(2).map(|xy| xy[1]).fold(f32::INFINITY, f32::min);
    let max = points.chunks_exact(2).map(|xy| xy[1]).fold(f32::NEG_INFINITY, f32::max);
    (min + max) * 0.5
}

// #7914: x=cos(t) reaches 1 inside each of these trims. Rotation about X
// cannot remove that extremum, even when both projected endpoints coincide.
#[test]
fn issue_7914_projected_arcs_retain_interior_extrema_and_reversed_trims() {
    for axis in ["0.,-1.,0.", "0.,-1.,0.00000001"] {
        for (start, end, sense) in [
            (-std::f64::consts::FRAC_PI_3, std::f64::consts::FRAC_PI_3, ".T."),
            (std::f64::consts::FRAC_PI_3, -std::f64::consts::FRAC_PI_3, ".F."),
            (-1.2, 0.5, ".T."),
        ] {
            let geometry = format!(r#"
#30=IFCAXIS2PLACEMENT2D(#31,$);
#31=IFCCARTESIANPOINT((0.,0.));
#32=IFCCIRCLE(#30,1.);
#33=IFCTRIMMEDCURVE(#32,(IFCPARAMETERVALUE({start})),(IFCPARAMETERVALUE({end})),{sense},.PARAMETER.);
"#);
            let data = extract_symbolic_data(&fixture(axis, "#33", &geometry));
            assert_eq!(data.polylines.len(), 1);
            let points = &data.polylines[0].points;
            let max_x = points.chunks_exact(2).map(|xy| xy[0]).fold(f32::NEG_INFINITY, f32::max);
            assert!(max_x > 0.99, "interior extremum lost: {axis}, {start}..{end}, {points:?}");
        }
    }
}

// #7914: preserving a hidden extremum must not stop genuinely stationary
// trims or ordinary shallow arcs from using the established chord output.
#[test]
fn issue_7914_zero_span_and_shallow_arcs_keep_the_chord_path() {
    for end in [0.0_f64, 0.01] {
        let geometry = format!(r#"
#30=IFCAXIS2PLACEMENT2D(#31,$);
#31=IFCCARTESIANPOINT((0.,0.));
#32=IFCCIRCLE(#30,1.);
#33=IFCTRIMMEDCURVE(#32,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE({end})),.T.,.PARAMETER.);
"#);
        let data = extract_symbolic_data(&fixture("0.,0.,1.", "#33", &geometry));
        assert_eq!(data.polylines.len(), 1);
        let points = &data.polylines[0].points;
        assert_eq!(points.len(), 4);
        assert_eq!(&points[..2], &[1.0, 0.0]);
        assert!((f64::from(points[2]) - end.cos()).abs() < 0.000001);
        assert!((f64::from(points[3]) + end.sin()).abs() < 0.000001);
    }
}

fn mixed_geometry(unit: f64, z: f64) -> String {
    let r = 1.0 / unit;
    let z = z / unit;
    format!(r#"
#30=IFCAXIS2PLACEMENT3D(#31,$,$);
#31=IFCCARTESIANPOINT((0.,0.,{z}));
#32=IFCCIRCLE(#30,{r});
#33=IFCCARTESIANPOINT(({},0.,{z}));
#34=IFCCARTESIANPOINT(({r},0.,{z}));
#35=IFCPOLYLINE((#33,#34));
#36=IFCCARTESIANPOINTLIST3D((({},{},{z}),({r},{},{z}),({r},{r},{z}),({},{r},{z})));
#37=IFCINDEXEDPOLYCURVE(#36,$,.F.);
#38=IFCANNOTATIONFILLAREA(#37,$);
#39=IFCANNOTATIONFILLAREA(#63,$);
#60=IFCCARTESIANPOINT(({}, {},{z}));
#61=IFCCARTESIANPOINT(({r}, {},{z}));
#62=IFCCARTESIANPOINT(({r},{r},{z}));
#64=IFCCARTESIANPOINT(({}, {r},{z}));
#63=IFCPOLYLINE((#60,#61,#62,#64));
"#, -r, -r, -r, -r, -r, -r, -r, -r, -r)
}

// #7914: all five primitives share a plane and center. The conic and each
// vertex-list consumer must use the same Z coupling, with one unit conversion.
#[test]
fn issue_7914_circle_polyline_indexed_curve_and_fills_stay_aligned() {
    for unit in [1.0, 0.001] {
        let mut source = fixture("0.,-0.00001,0.99999999995", "#32,#35,#37,#38,#39", &mixed_geometry(unit, 1_000_000.0));
        if unit == 0.001 {
            source = source.replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.");
        }
        let data = extract_symbolic_data(&source);
        assert_eq!(data.circles.len() + data.polylines.len(), 3);
        assert_eq!(data.fills.len(), 2);
        for line in &data.polylines {
            assert!((center_y(&line.points) - 10.0).abs() < 0.0001, "line center: {:?}", line.points);
        }
        for circle in &data.circles {
            assert!((circle.center_y - 10.0).abs() < 0.0001);
        }
        for fill in &data.fills {
            assert!((center_y(&fill.points) - 10.0).abs() < 0.0001, "fill center: {:?}", fill.points);
        }
    }
}

// #7914: a downward local Z axis maps z=5 to elevation -5 for every primitive.
// Adding local Z to the placement translation instead gives +5.
#[test]
fn issue_7914_vertex_elevation_uses_the_full_frame() {
    let source = fixture("0.,0.,-1.", "#32,#35,#37,#38,#39", &mixed_geometry(1.0, 5.0));
    let data = extract_symbolic_data(&source);
    assert_eq!(data.circles.len(), 1);
    assert_eq!(data.polylines.len(), 2);
    assert_eq!(data.fills.len(), 2);
    for elevation in data.circles.iter().map(|p| p.world_y)
        .chain(data.polylines.iter().map(|p| p.world_y))
        .chain(data.fills.iter().map(|p| p.world_y))
    {
        assert_eq!(elevation, -5.0);
    }
}

// #7914: the public text contract is a (cos,sin) direction, even when the
// projected frame is not a similarity. Area scale is not X-column length.
#[test]
fn issue_7914_tilted_text_keeps_a_unit_baseline() {
    let geometry = "#30=IFCAXIS2PLACEMENT3D(#12,$,#33);\n#32=IFCTEXTLITERAL('T',#30,.RIGHT.);\n#33=IFCDIRECTION((1.,1.,0.));";
    for (axis, expected_x, expected_y) in [
        ("0.,0.,1.", std::f32::consts::FRAC_1_SQRT_2, -std::f32::consts::FRAC_1_SQRT_2),
        ("0.8660254037844386,0.,0.5", 1.0 / 5_f32.sqrt(), -2.0 / 5_f32.sqrt()),
    ] {
        let data = extract_symbolic_data(&fixture(axis, "#32", geometry));
        assert_eq!(data.texts.len(), 1);
        let text = &data.texts[0];
        let length = text.dir_x.hypot(text.dir_y);
        assert!((length - 1.0).abs() < 0.000001, "baseline length {length}: {text:?}");
        assert!((text.dir_x - expected_x).abs() < 0.000001, "baseline X: {text:?}");
        assert!((text.dir_y - expected_y).abs() < 0.000001, "baseline Y: {text:?}");
    }
}
