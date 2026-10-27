// SPDX-License-Identifier: MPL-2.0
//! #7779: surface control-point rows retain position or refuse as a whole.
use super::*;

#[test]
fn issue_7779_surface_control_points_use_canonical_admission() {
    for (record, expected) in [
        ("IFCCARTESIANPOINT((1.,2.))", Some(Point3::new(1., 2., 0.))),
        (
            "IFCCARTESIANPOINT((1.,2.,3.))",
            Some(Point3::new(1., 2., 3.)),
        ),
        ("IFCDIRECTION((1.,2.,3.))", None),
        ("IFCCARTESIANPOINT((1.,2.,'bad'))", None),
        ("IFCCARTESIANPOINT((1.,2.,1.E400))", None),
        ("IFCCARTESIANPOINT((1.))", None),
        ("IFCCARTESIANPOINT((1.,2.,3.,4.))", None),
    ] {
        let content = format!("#1=IFCCARTESIANPOINT((0.,0.,0.));#2={record};#10=IFCBSPLINESURFACE(1,1,((#1,#2),(#2,#1)),.PLANE_SURF.,.F.,.F.,.F.);");
        let mut decoder = EntityDecoder::new(&content);
        let surface = decoder.decode_by_id(10).unwrap();
        match expected {
            Some(point) => {
                let grid = parse_control_points(&surface, &mut decoder).unwrap();
                assert_eq!(
                    grid,
                    [
                        vec![Point3::new(0., 0., 0.), point],
                        vec![point, Point3::new(0., 0., 0.)]
                    ]
                );
                assert_eq!(decoder.refused_records(), 0);
            }
            None => {
                assert!(
                    parse_control_points(&surface, &mut decoder).is_err(),
                    "{record}"
                );
                assert_eq!(decoder.refused_record_ids(), [2]);
            }
        }
    }
}
