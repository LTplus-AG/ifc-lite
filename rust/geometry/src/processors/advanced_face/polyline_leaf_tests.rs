// SPDX-License-Identifier: MPL-2.0
//! #7779: malformed authored leaves refuse, rather than fabricating a curve.
use super::*;

fn sample(source: &str, id: u32) -> Result<Vec<Point3<f64>>, Refused> {
    let mut decoder = EntityDecoder::new(source);
    let curve = decoder.decode_by_id(id).unwrap();
    try_sample_curve_polyline(&curve, &mut decoder, TessellationQuality::default())
}

#[test]
fn issue_7779_line_and_polyline_preserve_valid_points() {
    for point in [
        "IFCCARTESIANPOINT((1.,2.))",
        "IFCCARTESIANPOINT((1.,2.,0.))",
    ] {
        let source = format!("#1={point};#2=IFCDIRECTION((0.,2.));#3=IFCVECTOR(#2,3.);#4=IFCLINE(#1,#3);#5=IFCCARTESIANPOINT((4.,5.,6.));#6=IFCPOLYLINE((#1,#5));");
        assert_eq!(
            sample(&source, 4).unwrap(),
            [Point3::new(1., 2., 0.), Point3::new(1., 5., 0.)]
        );
        assert_eq!(
            sample(&source, 6).unwrap(),
            [Point3::new(1., 2., 0.), Point3::new(4., 5., 6.)]
        );
    }
}

#[test]
fn issue_7779_bad_points_refuse_lines_polylines_and_cartesian_trims() {
    for point in [
        "IFCDIRECTION((1.,2.,3.))",
        "IFCCARTESIANPOINT((1.,2.,'bad'))",
        "IFCCARTESIANPOINT((1.,2.,1.E400))",
        "IFCCARTESIANPOINT((1.))",
        "IFCCARTESIANPOINT((1.,2.,3.,4.))",
    ] {
        let source = format!("#1={point};#2=IFCDIRECTION((1.,0.,0.));#3=IFCVECTOR(#2,1.);#4=IFCLINE(#1,#3);#5=IFCCARTESIANPOINT((4.,5.,6.));#6=IFCPOLYLINE((#5,#1));#7=IFCLINE(#5,#3);#8=IFCTRIMMEDCURVE(#7,(#1),(#5),.T.,.CARTESIAN.);");
        for id in [4, 6, 8] {
            assert!(sample(&source, id).is_err(), "{point}, curve {id}");
        }
    }
    let source = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCDIRECTION((1.,0.));#3=IFCVECTOR(#2,1.);#4=IFCLINE(#1,#3);#8=IFCTRIMMEDCURVE(#4,(#999),(#1),.T.,.CARTESIAN.);";
    assert!(sample(source, 8).is_err());
}

#[test]
fn issue_7779_line_does_not_replace_bad_direction_with_unit_x() {
    for direction in [
        "IFCCARTESIANPOINT((1.,0.))",
        "IFCDIRECTION((0.,0.))",
        "IFCDIRECTION((1.,0.,'bad'))",
        "IFCDIRECTION((1.,0.,1.E400))",
        "IFCDIRECTION((1.))",
        "IFCDIRECTION((1.,0.,0.,0.))",
    ] {
        let source = format!(
            "#1=IFCCARTESIANPOINT((0.,0.));#2={direction};#3=IFCVECTOR(#2,2.);#4=IFCLINE(#1,#3);"
        );
        assert!(sample(&source, 4).is_err(), "{direction}");
    }
}

#[test]
fn issue_7779_cartesian_trim_sense_and_parameter_fallback_survive() {
    let source = "#1=IFCCARTESIANPOINT((1.,2.));#2=IFCDIRECTION((1.,0.));#3=IFCVECTOR(#2,2.);#4=IFCLINE(#1,#3);#5=IFCCARTESIANPOINT((4.,5.,6.));#8=IFCTRIMMEDCURVE(#4,(#1),(#5),.F.,.CARTESIAN.);#9=IFCTRIMMEDCURVE(#4,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);";
    assert_eq!(
        sample(source, 8).unwrap(),
        [Point3::new(4., 5., 6.), Point3::new(1., 2., 0.)]
    );
    assert_eq!(
        sample(source, 9).unwrap(),
        [Point3::new(1., 2., 0.), Point3::new(3., 2., 0.)]
    );
}
