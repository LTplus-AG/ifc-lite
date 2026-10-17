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
