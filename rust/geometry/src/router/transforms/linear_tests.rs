// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `linear.rs` (#859): authored `CartesianPosition` precedence
//! and polyline sampling.

use super::*;

mod cartesian_position_tests {
    use super::*;
    use ifc_lite_core::EntityDecoder;

    /// An `IfcLinearPlacement` whose curve IS sampleable (a straight
    /// polyline; sampling would put the origin at (5, 0, 0)) but that also
    /// carries an authored `CartesianPosition` at (10, 20, 30). The authored
    /// position wins: it is exact by construction, whereas the sampler is
    /// bounded by its sampling density, so the exporter's pre-baked answer
    /// stays the more trustworthy of the two whenever it exists.
    const AUTHORED_IFC: &str = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
#2=IFCCARTESIANPOINT((100.,0.,0.));\n\
#3=IFCPOLYLINE((#1,#2));\n\
#4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#3);\n\
#5=IFCAXIS2PLACEMENTLINEAR(#4,$,$);\n\
#6=IFCCARTESIANPOINT((10.,20.,30.));\n\
#7=IFCAXIS2PLACEMENT3D(#6,$,$);\n\
#8=IFCLINEARPLACEMENT($,#5,#7);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    #[test]
    fn authored_cartesian_position_wins_over_curve_sampling() {
        let mut decoder = EntityDecoder::new(AUTHORED_IFC);
        let placement = decoder.decode_by_id(8).expect("decode #8");
        let router = GeometryRouter::new();
        let m = router
            .resolve_linear_placement_with_depth(&placement, &mut decoder, 0)
            .expect("resolve linear placement")
            .transform;
        assert!(
            (m[(0, 3)] - 10.0).abs() < 1e-9
                && (m[(1, 3)] - 20.0).abs() < 1e-9
                && (m[(2, 3)] - 30.0).abs() < 1e-9,
            "authored CartesianPosition (10, 20, 30) must win; got \
             ({}, {}, {}) — (5, 0, 0) means the sampler took priority",
            m[(0, 3)],
            m[(1, 3)],
            m[(2, 3)],
        );
    }

    /// Same precedence on an `IfcGradientCurve` basis. The 3D distance of
    /// 5 m reaches x = 5 / sqrt(1 + grade²); the authored frame still wins.
    #[test]
    fn authored_position_wins_over_gradient_curve_elevation() {
        let gradient = AUTHORED_IFC.replace(
            "#4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#3);",
            "#20=IFCCARTESIANPOINT((0.,50.));\n#21=IFCDIRECTION((1.,0.1));\n#22=IFCAXIS2PLACEMENT2D(#20,#21);\n\
#23=IFCDIRECTION((1.,0.));\n#24=IFCVECTOR(#23,1.);\n#25=IFCLINE(#20,#24);\n\
#26=IFCCURVESEGMENT(.CONTINUOUS.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#25);\n\
#27=IFCGRADIENTCURVE((#26),.F.,#3,$);\n\
#4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#27);",
        );
        let station = 5.0 / (1.0_f64 + 0.1_f64 * 0.1_f64).sqrt();
        for (content, want) in [(gradient.clone(), (10.0, 20.0, 30.0)),
            (gradient.replace("#8=IFCLINEARPLACEMENT($,#5,#7);", "#8=IFCLINEARPLACEMENT($,#5,$);"), (station, 0.0, 50.0 + station * 0.1))] {
            let mut decoder = EntityDecoder::new(&content);
            let placement = decoder.decode_by_id(8).expect("decode #8");
            let m = GeometryRouter::new()
                .resolve_linear_placement_with_depth(&placement, &mut decoder, 0)
                .expect("resolve linear placement")
                .transform;
            let got = (m[(0, 3)], m[(1, 3)], m[(2, 3)]);
            assert!((got.0 - want.0).abs() < 1e-6 && (got.1 - want.1).abs() < 1e-6 && (got.2 - want.2).abs() < 1e-6,
                "expected {want:?}, got {got:?}");
        }
    }

    /// #5327: authored vertical chainage can begin at 1000 while the
    /// horizontal base curve begins at local station zero. Linear placement
    /// and sectioned solids must invert the same 3D length and rebase the
    /// same profile before placing an object without CartesianPosition.
    #[test]
    fn gradient_linear_placement_rebases_authored_station_and_3d_length() {
        let content = AUTHORED_IFC.replace(
            "#4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#3);",
            "#20=IFCCARTESIANPOINT((1000.,50.));\n#21=IFCDIRECTION((1.,0.1));\n#22=IFCAXIS2PLACEMENT2D(#20,#21);\n\
#23=IFCDIRECTION((1.,0.));\n#24=IFCVECTOR(#23,1.);\n#25=IFCLINE(#20,#24);\n\
#26=IFCCURVESEGMENT(.CONTINUOUS.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#25);\n\
#27=IFCGRADIENTCURVE((#26),.F.,#3,$);\n\
#4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#27);",
        ).replace("#8=IFCLINEARPLACEMENT($,#5,#7);", "#8=IFCLINEARPLACEMENT($,#5,$);");
        let mut decoder = EntityDecoder::new(&content);
        let placement = decoder.decode_by_id(8).expect("decode placement");
        let m = GeometryRouter::new()
            .resolve_linear_placement_with_depth(&placement, &mut decoder, 0)
            .expect("resolve placement").transform;
        let station = 5.0 / (1.0_f64 + 0.1_f64 * 0.1_f64).sqrt();
        assert!((m[(0, 3)] - station).abs() < 1e-3, "horizontal station = {}", m[(0, 3)]);
        assert!((m[(2, 3)] - (50.0 + 0.1 * station)).abs() < 1e-3,
            "rebased elevation = {}", m[(2, 3)]);
    }

    /// With no authored position (`$`), the sampler still resolves the
    /// station: 5 m along the +X polyline.
    #[test]
    fn sampler_still_used_when_no_authored_position() {
        let content = AUTHORED_IFC.replace("#8=IFCLINEARPLACEMENT($,#5,#7);", "#8=IFCLINEARPLACEMENT($,#5,$);");
        let mut decoder = EntityDecoder::new(&content);
        let placement = decoder.decode_by_id(8).expect("decode #8");
        let router = GeometryRouter::new();
        let m = router
            .resolve_linear_placement_with_depth(&placement, &mut decoder, 0)
            .expect("resolve linear placement")
            .transform;
        assert!(
            (m[(0, 3)] - 5.0).abs() < 1e-9 && m[(1, 3)].abs() < 1e-9 && m[(2, 3)].abs() < 1e-9,
            "sampling a straight +X polyline at 5 m must give (5, 0, 0); got \
             ({}, {}, {})",
            m[(0, 3)],
            m[(1, 3)],
            m[(2, 3)],
        );
    }

    /// #7335: a writer bakes the strict local frame back into the file, so it
    /// must stay in file units whatever unit scale the router renders with,
    /// for both the sampled curve and the authored CartesianPosition.
    #[test]
    fn strict_local_frame_is_in_file_units_for_any_router_scale() {
        for content in [
            AUTHORED_IFC.to_string(),
            AUTHORED_IFC.replace("#8=IFCLINEARPLACEMENT($,#5,#7);", "#8=IFCLINEARPLACEMENT($,#5,$);"),
        ] {
            let mut decoder = EntityDecoder::new(&content);
            let placement = decoder.decode_by_id(8).expect("decode #8");
            let metre = GeometryRouter::with_scale(1.0)
                .resolve_linear_placement_local_strict(&placement, &mut decoder)
                .expect("strict local frame");
            let milli = GeometryRouter::with_scale(0.001)
                .resolve_linear_placement_local_strict(&placement, &mut decoder)
                .expect("strict local frame");
            assert_eq!(metre, milli);
            assert!(metre[12] >= 5.0, "translation stays in file units: {metre:?}");
        }
    }
}

mod sample_polyline_tests {
    use super::*;

    #[test]
    fn samples_at_start_middle_end() {
        // Straight line along +X from (0,0,0) to (10,0,0) in 1 m segments.
        let samples: Vec<Point3<f64>> = (0..=10)
            .map(|i| Point3::new(i as f64, 0.0, 0.0))
            .collect();

        let (p0, t0) = sample_polyline_at_distance(&samples, 0.0).unwrap();
        assert!((p0 - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t0 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p5, t5) = sample_polyline_at_distance(&samples, 5.0).unwrap();
        assert!((p5 - Point3::new(5.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t5 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p10, _) = sample_polyline_at_distance(&samples, 10.0).unwrap();
        assert!((p10 - Point3::new(10.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn clamps_past_end() {
        let samples = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(3.0, 4.0, 0.0), // length 5
        ];
        let (p, t) = sample_polyline_at_distance(&samples, 99.0).unwrap();
        assert!((p - Point3::new(3.0, 4.0, 0.0)).norm() < 1e-9);
        assert!((t.norm() - 1.0).abs() < 1e-9, "tangent must be unit");
    }

    #[test]
    fn empty_returns_none() {
        let none = sample_polyline_at_distance(&[], 0.0);
        assert!(none.is_none());
        let single = sample_polyline_at_distance(&[Point3::new(0.0, 0.0, 0.0)], 0.0);
        assert!(single.is_none());
    }
}
