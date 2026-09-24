// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5409: a Revit export writes its neutral grey onto opening geometry, through
//! an `IfcIndexedColourMap` on tessellated openings and an `IfcStyledItem` on
//! extruded ones. The style precedence honoured it, so those openings drew as
//! opaque grey solids plugging the holes they cut, beside the unstyled openings
//! in the translucent overlay. Every opening renders the one overlay colour.
//!
//! #10 is styled by an indexed colour map (the tessellated Revit case), #20 by a
//! styled item on its body, #30 carries no style (the control that was already
//! right), #40 is an `IfcOpeningStandardCase` (a subtype, styled), and #50 is a
//! styled `IfcBuildingElementProxy`, which must keep its authored colour: the
//! rule is about the opening class, not a blanket override.

use ifc_lite_core::IfcType;
use ifc_lite_processing::{default_color_for_type, process_geometry};

const OPENINGS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5409 opening display colour fixture'),'2;1');
FILE_NAME('openings.ifc','2026-09-24T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUj5409',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCCOLOURRGB($,0.498,0.498,0.498);
#8=IFCSURFACESTYLERENDERING(#7,$,$,$,$,$,$,$,.FLAT.);
#9=IFCSURFACESTYLE('Grey',.BOTH.,(#8));
#10=IFCOPENINGELEMENT('1IndexedGreyOpening0',$,'O1',$,$,#11,#12,$,.OPENING.);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#16=IFCCOLOURRGBLIST(((0.498,0.498,0.498)));
#17=IFCINDEXEDCOLOURMAP(#14,1.,#16,(1,1,1,1));
#20=IFCOPENINGELEMENT('1StyledGreyOpening00',$,'O2',$,$,#21,#22,$,.OPENING.);
#21=IFCLOCALPLACEMENT($,#5);
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#23=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#24));
#24=IFCTRIANGULATEDFACESET(#25,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#25=IFCCARTESIANPOINTLIST3D(((2.,0.,0.),(3.,0.,0.),(2.,1.,0.),(2.,0.,1.)));
#26=IFCSTYLEDITEM(#24,(#9),$);
#30=IFCOPENINGELEMENT('1PlainOpening000000',$,'O3',$,$,#31,#32,$,.OPENING.);
#31=IFCLOCALPLACEMENT($,#5);
#32=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#33=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#34));
#34=IFCTRIANGULATEDFACESET(#35,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#35=IFCCARTESIANPOINTLIST3D(((4.,0.,0.),(5.,0.,0.),(4.,1.,0.),(4.,0.,1.)));
#40=IFCOPENINGSTANDARDCASE('1StandardCaseOpening',$,'O4',$,$,#41,#42,$,.OPENING.);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#44));
#44=IFCTRIANGULATEDFACESET(#45,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#45=IFCCARTESIANPOINTLIST3D(((6.,0.,0.),(7.,0.,0.),(6.,1.,0.),(6.,0.,1.)));
#46=IFCSTYLEDITEM(#44,(#9),$);
#50=IFCBUILDINGELEMENTPROXY('1StyledGreyProxy0000',$,'P',$,$,#51,#52,$,$);
#51=IFCLOCALPLACEMENT($,#5);
#52=IFCPRODUCTDEFINITIONSHAPE($,$,(#53));
#53=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#54));
#54=IFCTRIANGULATEDFACESET(#55,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#55=IFCCARTESIANPOINTLIST3D(((8.,0.,0.),(9.,0.,0.),(8.,1.,0.),(8.,0.,1.)));
#56=IFCSTYLEDITEM(#54,(#9),$);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-3)
}

#[test]
fn every_opening_renders_the_overlay_colour_whatever_its_authored_style() {
    let result = process_geometry(OPENINGS_IFC);
    let overlay = default_color_for_type(IfcType::IfcOpeningElement).to_array();

    for (id, how) in [
        (10, "indexed colour map"),
        (20, "styled item"),
        (30, "no style"),
        (40, "IfcOpeningStandardCase styled item"),
    ] {
        let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == id).collect();
        assert!(!meshes.is_empty(), "opening #{id} ({how}) produced no mesh");
        for mesh in meshes {
            assert!(
                approx_eq(mesh.color, overlay),
                "opening #{id} ({how}) rendered {:?}, not the opening overlay {overlay:?}",
                mesh.color
            );
        }
    }

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 50)
        .expect("styled proxy #50 produced no mesh");
    assert!(
        approx_eq(proxy.color, [0.498, 0.498, 0.498, 1.0]),
        "a non-opening keeps its authored style, got {:?}",
        proxy.color
    );
}
