// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `OpeningFilterMode::IgnoreOpaque` suppresses a window or door with no
//! transparent part. The filter ran before the metadata phase resolved each
//! element's colour, so it only ever saw the type default: every `IfcWindow`
//! (default alpha 0.4) was kept even with an opaque surface style, and a door
//! whose glazing came only from the #407 material chain was suppressed.
//! Processing orchestrator review, finding 7.

use ifc_lite_processing::{process_geometry_filtered, MeshData, OpeningFilterMode};

/// #10: an `IfcWindow` whose only body item carries an opaque surface style.
/// #20: an `IfcDoor` with a frame and a pane item and no item style, associated
/// to a material list whose frame is opaque and whose pane is transparent (the
/// #913 split renders the pane transparent; no "glas" in any name, so only the
/// alpha counts). The opaque-first element colour for it is the frame's.
/// #60: an `IfcWindow` with no item style whose only material is the opaque
/// frame, so it renders in that colour, not the transparent window default.
/// #70: an `IfcWindow` whose only material is that opaque frame, but whose face
/// set is coloured by a transparent `IfcIndexedColourMap`, so it renders glazed.
/// #80: an `IfcDoor` whose body maps a representation that maps an opaque
/// frame and a transparent pane, each styled two mappings down. A scan that
/// stops short of the pane sees the frame's opaque style, or no style and the
/// opaque door default, so only one that reaches the pane keeps it.
const OPENINGS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ignore-opaque resolved colour fixture'),'2;1');
FILE_NAME('openings.ifc','2026-09-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6f',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWINDOW('1OpaqueStyledWindow0',$,'W',$,$,#11,#12,$,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#16=IFCSTYLEDITEM(#14,(#17),$);
#17=IFCSURFACESTYLE('Frame',.BOTH.,(#18));
#18=IFCSURFACESTYLERENDERING(#19,$,$,$,$,$,$,$,.FLAT.);
#19=IFCCOLOURRGB($,0.5,0.5,0.5);
#20=IFCDOOR('1MaterialPaneDoor000',$,'D',$,$,#21,#22,$,$,$,$,$,$);
#21=IFCLOCALPLACEMENT($,#5);
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#23=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#24,#26));
#24=IFCTRIANGULATEDFACESET(#25,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#25=IFCCARTESIANPOINTLIST3D(((2.,0.,0.),(3.,0.,0.),(2.,1.,0.),(2.,0.,1.)));
#26=IFCTRIANGULATEDFACESET(#27,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#27=IFCCARTESIANPOINTLIST3D(((4.,0.,0.),(5.,0.,0.),(4.,1.,0.),(4.,0.,1.)));
#30=IFCMATERIALLIST((#31,#40));
#31=IFCMATERIAL('Frame',$,$);
#32=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#33),#31);
#33=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#34));
#34=IFCSTYLEDITEM($,(#35),$);
#35=IFCSURFACESTYLE('Frame',.BOTH.,(#36));
#36=IFCSURFACESTYLERENDERING(#37,$,$,$,$,$,$,$,.FLAT.);
#37=IFCCOLOURRGB($,0.5,0.5,0.5);
#40=IFCMATERIAL('Pane',$,$);
#41=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#42),#40);
#42=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#43));
#43=IFCSTYLEDITEM($,(#44),$);
#44=IFCSURFACESTYLE('Pane',.BOTH.,(#45));
#45=IFCSURFACESTYLERENDERING(#46,0.7,$,$,$,$,$,$,.FLAT.);
#46=IFCCOLOURRGB($,0.7,0.9,0.5);
#50=IFCRELASSOCIATESMATERIAL('2RelAssocDoorMat0000',$,$,$,(#20),#30);
#60=IFCWINDOW('1MaterialFrameWindow',$,'M',$,$,#61,#62,$,$,$,$,$,$);
#61=IFCLOCALPLACEMENT($,#5);
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#63=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#64));
#64=IFCTRIANGULATEDFACESET(#65,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#65=IFCCARTESIANPOINTLIST3D(((6.,0.,0.),(7.,0.,0.),(6.,1.,0.),(6.,0.,1.)));
#66=IFCRELASSOCIATESMATERIAL('2RelAssocWinMat00000',$,$,$,(#60),#31);
#70=IFCWINDOW('1IndexedGlassWindow0',$,'I',$,$,#71,#72,$,$,$,$,$,$);
#71=IFCLOCALPLACEMENT($,#5);
#72=IFCPRODUCTDEFINITIONSHAPE($,$,(#73));
#73=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#74));
#74=IFCTRIANGULATEDFACESET(#75,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#75=IFCCARTESIANPOINTLIST3D(((8.,0.,0.),(9.,0.,0.),(8.,1.,0.),(8.,0.,1.)));
#76=IFCCOLOURRGBLIST(((0.6,0.8,1.0)));
#77=IFCINDEXEDCOLOURMAP(#74,0.3,#76,(1,1,1,1));
#78=IFCRELASSOCIATESMATERIAL('2RelAssocWinMat00001',$,$,$,(#70),#31);
#80=IFCDOOR('1NestedMappedDoor0000',$,'N',$,$,#81,#82,$,$,$,$,$,$);
#81=IFCLOCALPLACEMENT($,#5);
#82=IFCPRODUCTDEFINITIONSHAPE($,$,(#83));
#83=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#84));
#84=IFCMAPPEDITEM(#85,#89);
#85=IFCREPRESENTATIONMAP(#5,#86);
#86=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#87,#88));
#87=IFCMAPPEDITEM(#90,#89);
#88=IFCMAPPEDITEM(#95,#89);
#89=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
#90=IFCREPRESENTATIONMAP(#5,#91);
#91=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#92));
#92=IFCTRIANGULATEDFACESET(#93,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#93=IFCCARTESIANPOINTLIST3D(((10.,0.,0.),(11.,0.,0.),(10.,1.,0.),(10.,0.,1.)));
#94=IFCSTYLEDITEM(#92,(#17),$);
#95=IFCREPRESENTATIONMAP(#5,#96);
#96=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#97));
#97=IFCTRIANGULATEDFACESET(#98,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#98=IFCCARTESIANPOINTLIST3D(((12.,0.,0.),(13.,0.,0.),(12.,1.,0.),(12.,0.,1.)));
#99=IFCSTYLEDITEM(#97,(#100),$);
#100=IFCSURFACESTYLE('Pane',.BOTH.,(#101));
#101=IFCSURFACESTYLERENDERING(#102,0.7,$,$,$,$,$,$,.FLAT.);
#102=IFCCOLOURRGB($,0.7,0.9,0.5);
ENDSEC;
END-ISO-10303-21;
"#;

fn meshes(mode: OpeningFilterMode) -> Vec<MeshData> {
    process_geometry_filtered(OPENINGS_IFC, mode).meshes
}

fn has_mesh(meshes: &[MeshData], id: u32) -> bool {
    meshes.iter().any(|m| m.express_id == id)
}

#[test]
fn ignore_opaque_judges_the_colour_the_opening_renders_with() {
    // The fixture meshes every opening when nothing is filtered, so an absence
    // below is the filter's doing.
    let unfiltered = meshes(OpeningFilterMode::Default);
    assert!(has_mesh(&unfiltered, 10), "window #10 meshes");
    assert!(has_mesh(&unfiltered, 60), "window #60 meshes");
    assert!(
        unfiltered
            .iter()
            .any(|m| m.express_id == 70 && m.color[3] < 1.0),
        "window #70 renders transparent from its indexed colour map"
    );
    assert!(
        unfiltered
            .iter()
            .any(|m| m.express_id == 80 && m.color[3] < 1.0),
        "door #80 renders its nested pane transparent"
    );
    assert!(
        unfiltered
            .iter()
            .any(|m| m.express_id == 20 && m.color[3] < 1.0),
        "door #20 renders a transparent pane sub-mesh"
    );

    let filtered = meshes(OpeningFilterMode::IgnoreOpaque);
    assert!(
        !has_mesh(&filtered, 10),
        "window #10 renders opaque (its only style is opaque), so IgnoreOpaque must suppress it"
    );
    assert!(
        !has_mesh(&filtered, 60),
        "window #60 renders in its opaque material colour, so IgnoreOpaque must suppress it"
    );
    assert!(
        has_mesh(&filtered, 70),
        "window #70 renders transparent from its indexed colour map, so IgnoreOpaque must keep it"
    );
    assert!(
        has_mesh(&filtered, 80),
        "door #80 has a transparent pane two mappings down, so IgnoreOpaque must keep it"
    );
    assert!(
        has_mesh(&filtered, 20),
        "door #20 has a transparent material appearance, so IgnoreOpaque must keep it"
    );
}
