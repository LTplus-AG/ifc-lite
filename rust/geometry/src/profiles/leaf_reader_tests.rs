// SPDX-License-Identifier: MPL-2.0
//! #7779: profile leaf refusals must reach the curve caller without fallback.
use super::*;

#[test]
fn issue_7779_profile_polylines_preserve_order_or_refuse_whole_curve() {
    for (point, valid) in [
        ("IFCCARTESIANPOINT((3.,4.))", true),
        ("IFCCARTESIANPOINT((3.,4.,0.))", true),
        ("IFCDIRECTION((3.,4.))", false),
        ("IFCCARTESIANPOINT((3.,4.,'bad'))", false),
        ("IFCCARTESIANPOINT((3.,4.,1.E400))", false),
        ("IFCCARTESIANPOINT((3.))", false),
        ("IFCCARTESIANPOINT((3.,4.,0.,0.))", false),
    ] {
        let source = format!("#1=IFCCARTESIANPOINT((0.,0.));#2={point};#3=IFCPOLYLINE((#1,#2));");
        let mut decoder = EntityDecoder::new(&source);
        let curve = decoder.decode_by_id(3).unwrap();
        let processor = ProfileProcessor::new(IfcSchema::new());
        let planar = processor.process_curve(&curve, &mut decoder);
        let spatial = processor.get_curve_points(&curve, &mut decoder, TessellationQuality::Medium);
        if valid {
            assert_eq!(planar.unwrap(), [Point2::new(0., 0.), Point2::new(3., 4.)]);
            assert_eq!(
                spatial.unwrap(),
                [Point3::new(0., 0., 0.), Point3::new(3., 4., 0.)]
            );
        } else {
            assert!(planar.is_err(), "{point}");
            assert!(spatial.is_err(), "{point}");
        }
    }
}

#[test]
fn issue_7779_bad_cartesian_trim_cannot_become_full_conic() {
    for point in [
        "IFCCARTESIANPOINT((1.,'bad'))",
        "IFCDIRECTION((1.,0.))",
        "IFCCARTESIANPOINT((1.,0.,1.E400))",
        "IFCCARTESIANPOINT((1.,0.,0.,0.))",
        "IFCCARTESIANPOINT((IFCLENGTHMEASURE(1.),0.))",
        "IFCCARTESIANPOINT((1.,0.),$)",
    ] {
        for master in ["CARTESIAN", "PARAMETER"] {
            let source = format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCCIRCLE(#2,1.);#4={point};#5=IFCTRIMMEDCURVE(#3,(#4,IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.{master}.);");
            let mut decoder = EntityDecoder::new(&source);
            let curve = decoder.decode_by_id(5).unwrap();
            let processor = ProfileProcessor::new(IfcSchema::new());
            assert!(
                processor.process_curve(&curve, &mut decoder).is_err(),
                "{point}/{master}"
            );
            assert!(
                processor
                    .get_curve_points(&curve, &mut decoder, TessellationQuality::Medium)
                    .is_err(),
                "{point}/{master}"
            );
        }
    }
}

#[test]
fn issue_7779_indexed_point_rows_preserve_indices_or_refuse() {
    for (list, valid) in [
        ("IFCCARTESIANPOINTLIST2D(((0.,0.),(3.,4.)))", true),
        ("IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(3.,4.,0.)))", true),
        ("IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(3.,4.)))", false),
        ("IFCCARTESIANPOINTLIST2D(((0.,0.),(3.,4.,0.)))", false),
        ("IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(3.,'bad',0.)))", false),
        (
            "IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(3.,4.,1.E400)))",
            false,
        ),
        ("IFCCARTESIANPOINTLIST3D(((0.,0.,0.),$,(3.,4.,0.)))", false),
    ] {
        let source = format!("#1={list};#2=IFCINDEXEDPOLYCURVE(#1,(IFCLINEINDEX((1,2))),.F.);");
        let mut decoder = EntityDecoder::new(&source);
        let curve = decoder.decode_by_id(2).unwrap();
        let processor = ProfileProcessor::new(IfcSchema::new());
        let result = processor.get_curve_points(&curve, &mut decoder, TessellationQuality::Medium);
        if valid {
            assert_eq!(
                result.unwrap(),
                [Point3::new(0., 0., 0.), Point3::new(3., 4., 0.)]
            );
        } else {
            assert!(result.is_err(), "{list}");
        }
    }
}

#[test]
fn issue_7779_profile_conic_preserves_absent_bound_recovery() {
    for trims in ["(),()", "(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.))"] {
        let source = format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCCIRCLE(#2,1.);#5=IFCTRIMMEDCURVE(#3,{trims},.T.,.PARAMETER.);");
        let mut decoder = EntityDecoder::new(&source);
        let curve = decoder.decode_by_id(5).unwrap();
        let processor = ProfileProcessor::new(IfcSchema::new());
        let points = processor
            .get_curve_points(&curve, &mut decoder, TessellationQuality::Medium)
            .unwrap();
        assert!(points.len() > 2);
        assert!(points
            .iter()
            .all(|p| (p.x * p.x + p.y * p.y - 1.).abs() < 1e-12 && p.z == 0.));
        assert!((points[0] - Point3::new(1., 0., 0.)).norm() < 1e-12);
    }
}

/// #7779 / #8045: eager list decoding must still see a later decode refusal
/// before leaf validation of an earlier malformed point. A one-pass rewrite
/// would refuse #1 instead of #2 in strict mode, changing the census.
#[test]
fn issue_7779_polyline_reuse_preserves_eager_refusal_order() {
    let source = "#1=IFCCARTESIANPOINT((1.));\n\
                  #2=IFCCARTESIANPOINT((1.E400,0.));\n\
                  #3=IFCPOLYLINE((#1,#2));";
    for strict in [false, true] {
        for spatial in [false, true] {
            let mut decoder = EntityDecoder::new(source);
            if strict {
                decoder = decoder.with_strict_reals();
            }
            let curve = decoder.decode_by_id(3).unwrap();
            let processor = ProfileProcessor::new(IfcSchema::new());
            let failed = if spatial {
                processor.process_polyline_3d(&curve, &mut decoder).is_err()
            } else {
                processor.process_polyline(&curve, &mut decoder).is_err()
            };
            assert!(failed);
            assert_eq!(decoder.refused_record_ids(), [if strict { 2 } else { 1 }]);
            assert_eq!(decoder.refused_records(), 1);
        }
    }
}
