// SPDX-License-Identifier: MPL-2.0
//! #7779: gradient placement leaves preserve station/height and authored grade.
use super::*;

#[test]
fn issue_7779_gradient_direction_admission_and_absence() {
    for (direction, expected) in [
        ("$", Some(0.)),
        ("#2", Some(0.5)),
        ("#999", None),
        ("#3", None),
        ("#4", None),
        ("#5", None),
        ("#6", None),
    ] {
        let source = format!("#1=IFCCARTESIANPOINT((10.,20.));#2=IFCDIRECTION((2.,1.));#3=IFCCARTESIANPOINT((2.,1.));#4=IFCDIRECTION((2.,'bad'));#5=IFCDIRECTION((2.,1.E400));#6=IFCDIRECTION((0.,1.));#7=IFCAXIS2PLACEMENT2D(#1,{direction});#8=IFCLINE(#1,$);#9=IFCCURVESEGMENT(.CONTINUOUS.,#7,0.,5.,#8);");
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(9).unwrap();
        let segment = parse_segment(&entity, &mut decoder);
        assert_eq!(
            segment.map(|s| (s.start, s.height, s.grade)),
            expected.map(|g| (10., 20., g)),
            "{direction}"
        );
    }
}

#[test]
fn issue_7779_gradient_rejects_bad_location_and_3d_axis_slot() {
    for placement in [
        "IFCAXIS2PLACEMENT2D(#2,$)",
        "IFCAXIS2PLACEMENT2D(#3,$)",
        "IFCAXIS2PLACEMENT3D(#1,#4,$)",
    ] {
        let source = format!("#1=IFCCARTESIANPOINT((10.,20.));#2=IFCCARTESIANPOINT((10.,'bad'));#3=IFCDIRECTION((10.,20.));#4=IFCDIRECTION((1.,1.,0.));#7={placement};#8=IFCLINE(#1,$);#9=IFCCURVESEGMENT(.CONTINUOUS.,#7,0.,5.,#8);");
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(9).unwrap();
        assert!(
            parse_segment(&entity, &mut decoder).is_none(),
            "{placement}"
        );
    }
}
