// SPDX-License-Identifier: MPL-2.0
//! #7779: removing the nonfinite compatibility reader must not fill a refused hole.
use super::*;
use crate::processors::take_face_refused;

#[test]
fn issue_7779_polyloop_leaf_refusal_rejects_whole_face_and_preserves_sibling() {
    for point in [
        "IFCCARTESIANPOINT((1.,1.,1.E400))",
        "IFCCARTESIANPOINT((1.,1.,'bad'))",
        "IFCDIRECTION((1.,1.,0.))",
        "IFCCARTESIANPOINT((1.))",
        "IFCCARTESIANPOINT((1.,1.,0.,0.))",
    ] {
        let source = format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCCARTESIANPOINT((4.,0.));#3=IFCCARTESIANPOINT((4.,4.));#4=IFCCARTESIANPOINT((0.,4.));#5=IFCPOLYLOOP((#1,#2,#3,#4));#6=IFCFACEOUTERBOUND(#5,.T.);#7={point};#8=IFCCARTESIANPOINT((2.,1.));#9=IFCCARTESIANPOINT((1.,2.));#10=IFCPOLYLOOP((#7,#8,#9));#11=IFCFACEBOUND(#10,.T.);");
        let mut decoder = EntityDecoder::new(&source);
        let _ = take_face_refused();
        assert!(
            read_simple_face_bounds(&IfcType::IfcFace, vec![6, 11], &mut decoder).is_none(),
            "{point}"
        );
        assert_eq!(take_face_refused(), [IfcType::IfcFace]);
        let (outer, holes) =
            read_simple_face_bounds(&IfcType::IfcFace, vec![6], &mut decoder).unwrap();
        assert_eq!(
            outer.unwrap(),
            [
                Point3::new(0., 0., 0.),
                Point3::new(4., 0., 0.),
                Point3::new(4., 4., 0.),
                Point3::new(0., 4., 0.)
            ]
        );
        assert!(holes.is_empty());
        assert!(take_face_refused().is_empty());
    }
}

#[test]
fn issue_7779_polyloop_valid_hole_remains_a_hole() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCCARTESIANPOINT((4.,0.,0.));#3=IFCCARTESIANPOINT((0.,4.));#4=IFCPOLYLOOP((#1,#2,#3));#5=IFCFACEOUTERBOUND(#4,.T.);#6=IFCCARTESIANPOINT((1.,1.));#7=IFCCARTESIANPOINT((2.,1.));#8=IFCCARTESIANPOINT((1.,2.));#9=IFCPOLYLOOP((#6,#7,#8));#10=IFCFACEBOUND(#9,.T.);";
    let mut decoder = EntityDecoder::new(source);
    let _ = take_face_refused();
    let (outer, holes) =
        read_simple_face_bounds(&IfcType::IfcFace, vec![5, 10], &mut decoder).unwrap();
    assert_eq!(outer.unwrap().len(), 3);
    assert_eq!(
        holes,
        [vec![
            Point3::new(1., 1., 0.),
            Point3::new(2., 1., 0.),
            Point3::new(1., 2., 0.)
        ]]
    );
    assert!(take_face_refused().is_empty());
}
