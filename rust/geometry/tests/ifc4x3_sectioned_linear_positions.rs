// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC4x3 `IfcSectionedSolidHorizontal` whose `CrossSectionPositions` are
//! `IfcAxis2PlacementLinear` → `IfcPointByDistanceExpression` (the IFC4x3
//! replacement for IFC4x1's `IfcDistanceExpression`). Before the fix every
//! such solid failed to parse and was dropped — on the buildingSMART
//! "Viadotto Acerno" bridge that was all 638 of them, i.e. the entire
//! superstructure. Shape mirrors that file's precast deck beams: a 3D
//! `IfcPolyline` directrix at deck elevation, two stations at its ends.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,55.));
#2=IFCCARTESIANPOINT((0.,20.,54.));
#3=IFCPOLYLINE((#1,#2));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,0.5);
#5=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#3);
#6=IFCAXIS2PLACEMENTLINEAR(#5,$,$);
#7=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(20.0249843945),$,$,$,#3);
#8=IFCAXIS2PLACEMENTLINEAR(#7,$,$);
#9=IFCSECTIONEDSOLIDHORIZONTAL(#3,(#4,#4),(#6,#8));
#10=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),3.,$,$,#3);
#11=IFCAXIS2PLACEMENTLINEAR(#10,$,$);
#12=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(20.0249843945),3.,$,$,#3);
#13=IFCAXIS2PLACEMENTLINEAR(#12,$,$);
#14=IFCSECTIONEDSOLIDHORIZONTAL(#3,(#4,#4),(#11,#13));
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCDIRECTION((1.,0.));
#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCVECTOR(#21,1.);
#24=IFCLINE(#20,#23);
#25=IFCCIRCLE(#22,100.);
#26=IFCCURVESEGMENT(.CONTINUOUS.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.0796326795),#25);
#27=IFCCARTESIANPOINT((100.,100.));
#28=IFCDIRECTION((0.,1.));
#29=IFCAXIS2PLACEMENT2D(#27,#28);
#30=IFCCURVESEGMENT(.DISCONTINUOUS.,#29,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#31=IFCCOMPOSITECURVE((#26,#30),.F.);
#32=IFCCARTESIANPOINT((0.,50.));
#33=IFCDIRECTION((1.,0.01));
#34=IFCAXIS2PLACEMENT2D(#32,#33);
#35=IFCCURVESEGMENT(.CONTINUOUS.,#34,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.08),#24);
#36=IFCCARTESIANPOINT((157.0796326795,51.570796326795));
#37=IFCAXIS2PLACEMENT2D(#36,#33);
#38=IFCCURVESEGMENT(.DISCONTINUOUS.,#37,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#39=IFCGRADIENTCURVE((#35,#38),.F.,#31,$);
#40=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#39);
#41=IFCAXIS2PLACEMENTLINEAR(#40,$,$);
#42=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(157.0796326795),$,$,$,#39);
#43=IFCAXIS2PLACEMENTLINEAR(#42,$,$);
#44=IFCSECTIONEDSOLIDHORIZONTAL(#39,(#4,#4),(#41,#43));
ENDSEC;
END-ISO-10303-21;
"#;

struct Bbox {
    min: [f32; 3],
    max: [f32; 3],
}

fn bbox(id: u32) -> Bbox {
    let index = ifc_lite_core::build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(id).expect("decode");
    assert_eq!(entity.ifc_type, IfcType::IfcSectionedSolidHorizontal);
    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("IFC4x3 linear cross-section positions must loft, not error");
    assert!(!mesh.positions.is_empty(), "#{id} produced an empty mesh");
    let mut b = Bbox { min: [f32::INFINITY; 3], max: [f32::NEG_INFINITY; 3] };
    for p in mesh.positions.chunks_exact(3) {
        for a in 0..3 {
            b.min[a] = b.min[a].min(p[a]);
            b.max[a] = b.max[a].max(p[a]);
        }
    }
    b
}

fn close(actual: f32, expected: f32, what: &str) {
    assert!((actual - expected).abs() < 0.05, "{what}: expected ≈{expected}, got {actual}");
}

#[test]
fn lofts_along_3d_polyline_at_its_elevation() {
    let b = bbox(9);
    // Runs the full directrix length along +Y …
    close(b.min[1], 0.0, "start station y");
    close(b.max[1], 20.0, "end station y");
    // … centred on it laterally (2 m wide profile) …
    close(b.min[0], -1.0, "x min");
    close(b.max[0], 1.0, "x max");
    // … and at the directrix's own elevation (55 → 54 m, 0.5 m deep
    // profile), not dropped to z = 0 by a straight-line fallback.
    close(b.max[2], 55.25, "z max");
    close(b.min[2], 53.75, "z min");
}

#[test]
fn positive_offset_lateral_is_left_of_travel() {
    // Travel is +Y, so IFC4x3's left (local +Y of the placement) is −X.
    let b = bbox(14);
    close(b.min[0], -4.0, "x min");
    close(b.max[0], -2.0, "x max");
}

#[test]
fn lofts_along_gradient_curve_following_arc_and_grade() {
    // Quarter circle R = 100 (0,0) → (100,100) on a +1 % grade from 50 m:
    // the loft must bulge out to the arc (x reaches 100, y reaches 100),
    // not run straight along +Y at z = 0 as the old fallback did.
    let b = bbox(44);
    close(b.max[0], 101.0, "x max (arc end + half width)");
    close(b.max[1], 100.0, "y max");
    close(b.min[2], 49.75, "z min at start");
    close(b.max[2], 51.82, "z max at end");
}
