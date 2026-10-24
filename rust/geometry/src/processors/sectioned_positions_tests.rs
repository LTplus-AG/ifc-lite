// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROC-AL-15 (#7776): an `IfcParameterValue` station on an `IfcCircle`
//! directrix is a plane angle, so it carries the file's angle unit.

use super::*;

fn station_on_circle(angle_unit: &str) -> f64 {
    let content = format!(
        r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCCIRCLE(#2,10.);
#4=IFCPOINTBYDISTANCEEXPRESSION(IFCPARAMETERVALUE(90.),$,$,$,#3);
#5=IFCAXIS2PLACEMENTLINEAR(#4,$,$);
#10=IFCPROJECT('p',$,'P',$,$,$,$,$,#12);
#12=IFCUNITASSIGNMENT((#13,#14));
#13=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
{angle_unit}
"#
    );
    let mut decoder = EntityDecoder::new(&content);
    let placement = decoder.decode_by_id(5).unwrap();
    let directrix = decoder.decode_by_id(3).unwrap();
    PositionAlongDirectrix::parse(&placement, &mut decoder, &directrix).unwrap().distance_along
}

#[test]
fn circle_parameter_station_applies_the_plane_angle_unit_proc_al_15_7776() {
    let degrees = station_on_circle(
        "#14=IFCCONVERSIONBASEDUNIT(#15,.PLANEANGLEUNIT.,'DEGREE',#16);\n\
         #15=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);\n\
         #16=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#17);\n\
         #17=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);",
    );
    // 90 degrees on a radius-10 circle is a quarter turn: 5 pi.
    assert!((degrees - 5.0 * std::f64::consts::PI).abs() < 1e-9, "{degrees}");
    // A radian file (the schema default) reads the parameter as written.
    let radians = station_on_circle("#14=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);");
    assert!((radians - 900.0).abs() < 1e-9, "{radians}");
}

/// A linear placement on a straight directrix whose RefDirection is `dir`.
fn linear_ref_direction(dir: &str) -> (Result<Option<Vector3<f64>>>, u64) {
    let content = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,0.));\n#3=IFCVECTOR(#2,1.);\n\
         #4=IFCLINE(#1,#3);\n#5=IFCPOINTBYDISTANCEEXPRESSION(5.,$,$,$,#4);\n\
         #6={dir};\n#7=IFCAXIS2PLACEMENTLINEAR(#5,$,#6);"
    );
    let mut decoder = EntityDecoder::new(&content);
    let placement = decoder.decode_by_id(7).unwrap();
    let directrix = decoder.decode_by_id(4).unwrap();
    let parsed = PositionAlongDirectrix::parse(&placement, &mut decoder, &directrix);
    (parsed.map(|p| p.ref_direction), decoder.refused_records())
}

/// F3b drift 3.2 (PROC-AL-10): the linear placement's directions are read by
/// the leaf reader. Base had no type check and read a missing ratio as 0, so a
/// cartesian point or `(0.,'x')` was sampled as a direction.
#[test]
fn a_linear_placement_direction_must_be_a_readable_ifcdirection() {
    let (control, refused) = linear_ref_direction("IFCDIRECTION((0.,2.,0.))");
    assert_eq!(control.expect("control"), Some(Vector3::new(0.0, 1.0, 0.0)));
    assert_eq!(refused, 0);
    // 2 ratios promote with z = 0, as base read them.
    let (promoted, _) = linear_ref_direction("IFCDIRECTION((0.,2.))");
    assert_eq!(promoted.expect("promoted"), Some(Vector3::new(0.0, 1.0, 0.0)));
    for bad in ["IFCCARTESIANPOINT((0.,1.,0.))", "IFCDIRECTION((0.,'x'))", "IFCDIRECTION((1.))"] {
        let (result, refused) = linear_ref_direction(bad);
        assert!(result.is_err(), "{bad}: base read it as a direction");
        assert_eq!(refused, 1, "{bad}");
    }
    // Readable but zero-length stays an error, uncounted, as on base.
    let (zero, refused) = linear_ref_direction("IFCDIRECTION((0.,0.,0.))");
    assert!(zero.is_err());
    assert_eq!(refused, 0);
}

/// Ratios whose squared length overflows used to normalise to the zero
/// vector and pass the zero-length check; they now keep their direction.
#[test]
fn a_linear_placement_direction_whose_squared_length_overflows_keeps_its_direction() {
    let (huge, refused) = linear_ref_direction("IFCDIRECTION((1.E308,1.E308,0.))");
    let (unit, _) = linear_ref_direction("IFCDIRECTION((1.,1.,0.))");
    assert_eq!(huge.expect("huge"), unit.expect("unit"));
    assert_eq!(refused, 0);
    // Subnormal ratios are still zero length, an error, uncounted.
    let (tiny, refused) = linear_ref_direction("IFCDIRECTION((5.E-324,0.,0.))");
    assert!(tiny.is_err());
    assert_eq!(refused, 0);
}
