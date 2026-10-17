// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{placement, Point2, ProfileProcessor, TessellationQuality};

// #7779 / #7880: a conic must use the same repaired frame as a rectangle.
#[test]
fn issue_7779_ellipse_and_rectangle_share_repaired_planar_axes() {
    for (ratios, x, y) in [
        ("0.,0.", 1.0, 0.0),
        ("0.,5.E-10", 1.0, 0.0),
        ("0.,1.E-9", 1.0, 0.0),
        ("0.,1.0001E-9", 0.0, 1.0),
        ("0.,2.E-9", 0.0, 1.0),
        ("3.,4.", 0.6, 0.8),
    ] {
        let content = format!(
            "#1=IFCCARTESIANPOINT((10.,20.));\n#2=IFCDIRECTION(({ratios}));\n\
             #3=IFCAXIS2PLACEMENT2D(#1,#2);\n#4=IFCELLIPSE(#3,2.,1.);\n\
             #5=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#4);\n\
             #6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#3,4.,2.);"
        );
        let mut decoder = EntityDecoder::new(&content);
        let processor = ProfileProcessor::new(IfcSchema::new());
        let ellipse = decoder.decode_by_id(5).unwrap();
        let rectangle = decoder.decode_by_id(6).unwrap();
        let ellipse = processor.process(&ellipse, &mut decoder, TessellationQuality::Medium).unwrap();
        let rectangle = processor.process(&rectangle, &mut decoder, TessellationQuality::Medium).unwrap();
        let center = Point2::new(10.0, 20.0);
        let expected_major_tip = center + nalgebra::Vector2::new(2.0 * x, 2.0 * y);
        assert!(ellipse.outer.iter().any(|p| (p - expected_major_tip).norm() < 1e-9),
            "{ratios}: ellipse must reach the repaired frame's major-axis tip {expected_major_tip:?}");
        // The unequal rectangle has corners at center ±2X ±Y.
        for (sx, sy) in [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)] {
            let corner = center + nalgebra::Vector2::new(2.0 * sx * x - sy * y, 2.0 * sx * y + sy * x);
            assert!(rectangle.outer.iter().any(|p| (p - corner).norm() < 1e-9), "{ratios}: {corner:?}");
        }
        assert_eq!(decoder.refused_records(), 0, "readable degenerate axes are repaired");
    }
}

// #7779 / #7880 review 4303997673: a present unreadable grid direction
// must refuse the placement, while an absent direction inherits +X.
#[test]
fn issue_7779_grid_direction_refusal_cannot_become_an_axis_aligned_success() {
    for (direction, expected) in [
        ("IFCDIRECTION((0.,1.,'bad'))", None),
        ("IFCDIRECTION((0.,1.))", Some((0.0, 1.0))),
        ("IFCDIRECTION((0.,1.,0.))", Some((0.0, 1.0))),
        ("IFCDIRECTION((0.,0.,0.))", Some((1.0, 0.0))),
    ] {
        let content = format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
            #1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCCARTESIANPOINT((10.,0.));\n\
            #3=IFCPOLYLINE((#1,#2));\n#4=IFCGRIDAXIS('P',#3,.T.);\n\
            #5=IFCCARTESIANPOINT((0.,10.));\n#6=IFCPOLYLINE((#1,#5));\n\
            #7=IFCGRIDAXIS('Q',#6,.T.);\n#8=IFCVIRTUALGRIDINTERSECTION((#4,#7),(0.,0.,0.));\n\
            #9={direction};\n#10=IFCGRIDPLACEMENT($,#8,#9);\n#11=IFCGRIDPLACEMENT($,#8,$);\nENDSEC;\nEND-ISO-10303-21;");
        let mut decoder = EntityDecoder::new(&content);
        let grid = decoder.decode_by_id(10).unwrap();
        let result = placement::resolve_chain(&grid, &mut decoder);
        if let Some((x, y)) = expected {
            let m = result.unwrap();
            assert_eq!((m[(0, 0)], m[(1, 0)]), (x, y));
            assert_eq!(decoder.refused_records(), 0);
        } else {
            assert!(result.is_err(), "unreadable authored direction became a frame: {result:?}");
            assert!(decoder.refused_records() > 0);
            assert!(decoder.get_placement_transform_cached(10).is_none());
        }
        let absent = decoder.decode_by_id(11).unwrap();
        let m = placement::resolve_chain(&absent, &mut decoder).unwrap();
        assert_eq!((m[(0, 0)], m[(1, 0)]), (1.0, 0.0));
    }
}

// #7779 / #7896 review 4304579830: all CTO variants require LocalOrigin.
#[test]
fn issue_7779_derived_profiles_refuse_a_missing_operator_origin() {
    for (kind, tail) in [
        ("2D", ""), ("2DNONUNIFORM", ",$"),
        ("3D", ",$"), ("3DNONUNIFORM", ",$,$,$"),
    ] {
        for origin in ["$", "*", "#1"] {
            let content = format!("#1=IFCCARTESIANPOINT((10.,20.));\n\
                #2=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,2.);\n\
                #3=IFCCARTESIANTRANSFORMATIONOPERATOR{kind}($,$,{origin},${tail});\n\
                #4=IFCDERIVEDPROFILEDEF(.AREA.,$,#2,#3,$);");
            let mut decoder = EntityDecoder::new(&content);
            let profile = decoder.decode_by_id(4).unwrap();
            let result = ProfileProcessor::new(IfcSchema::new())
                .process(&profile, &mut decoder, TessellationQuality::Medium);
            if origin == "#1" {
                let profile = result.unwrap();
                assert!(profile.outer.iter().all(|p| (8.0..=12.0).contains(&p.x) && (19.0..=21.0).contains(&p.y)));
                assert_eq!(decoder.refused_records(), 0);
            } else {
                assert!(result.is_err(), "{kind} {origin}: invented origin");
                assert_eq!(decoder.refused_records(), 1);
            }
        }
    }
}
