// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #913 §2.3 — an opening (window/door) with both an opaque frame
//! material and a transparent glazing material must distribute those colours
//! across its sub-meshes (alternating transparent/opaque preference), not paint
//! every part the same colour.
//!
//! Fixture: an `IfcWindow` with two tessellated items (frame + glass) and an
//! `IfcMaterialList` of two materials — grey opaque frame `[0.5,0.5,0.5,1]` and
//! green transparent glazing `[0.7,0.9,0.5,0.3]` — assigned via the material
//! chain (no direct `IfcStyledItem` on the geometry).

use ifc_lite_processing::process_geometry;

const FRAME: [f32; 4] = [0.5, 0.5, 0.5, 1.0];
const GLASS: [f32; 4] = [0.7, 0.9, 0.5, 0.3];

const WINDOW_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-913 submesh frame/glass fixture'),'2;1');
FILE_NAME('win.ifc','2026-06-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWINDOW('1WindowFrameGlass000',$,'W',$,$,#11,#12,$,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14,#16));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#16=IFCTRIANGULATEDFACESET(#17,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#17=IFCCARTESIANPOINTLIST3D(((2.,0.,0.),(3.,0.,0.),(2.,1.,0.),(2.,0.,1.)));
#40=IFCMATERIALLIST((#41,#42));
#41=IFCMATERIAL('Frame',$,$);
#42=IFCMATERIAL('Glass',$,$);
#43=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#44),#41);
#44=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#45));
#45=IFCSTYLEDITEM($,(#46),$);
#46=IFCSURFACESTYLE('Frame',.BOTH.,(#47));
#47=IFCSURFACESTYLERENDERING(#48,$,$,$,$,$,$,$,.FLAT.);
#48=IFCCOLOURRGB($,0.5,0.5,0.5);
#53=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#54),#42);
#54=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#55));
#55=IFCSTYLEDITEM($,(#56),$);
#56=IFCSURFACESTYLE('Glass',.BOTH.,(#57));
#57=IFCSURFACESTYLERENDERING(#58,0.7,$,$,$,$,$,$,.FLAT.);
#58=IFCCOLOURRGB($,0.7,0.9,0.5);
#60=IFCRELASSOCIATESMATERIAL('2RelAssocWindowMat0',$,$,$,(#10),#40);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn window_splits_frame_and_glass_across_submeshes() {
    let result = process_geometry(WINDOW_IFC);

    let parts: Vec<&_> = result.meshes.iter().filter(|m| m.express_id == 10).collect();
    assert_eq!(
        parts.len(),
        2,
        "expected one sub-mesh per window item; got {:?}",
        parts.iter().map(|m| m.color).collect::<Vec<_>>()
    );

    let has_frame = parts.iter().any(|m| approx_eq(m.color, FRAME));
    let has_glass = parts.iter().any(|m| approx_eq(m.color, GLASS));
    assert!(
        has_frame && has_glass,
        "expected one opaque frame {FRAME:?} and one transparent glass {GLASS:?}, got {:?}",
        parts.iter().map(|m| m.color).collect::<Vec<_>>()
    );

    // The two parts must differ — the whole point is they don't share a colour.
    assert!(
        !approx_eq(parts[0].color, parts[1].color),
        "both sub-meshes share a colour: {:?}",
        parts.iter().map(|m| m.color).collect::<Vec<_>>()
    );
}
