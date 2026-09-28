// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: the finish join takes the finish from the style the colour came
//! from, and from no other style.

use super::*;

/// A product whose one body item is an `IfcMappedItem` (#20) over a map whose
/// leaf (#30) is styled glossy (SpecularColour 0.75 -> roughness 0.25), and a
/// second product (#60) whose own mapped item (#70, same map) carries a
/// SHADING-only style of its own: a colour, no rendering, so no finish.
const MAPPED: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1occurrenceMapped0000',$,'A',$,$,$,#11,$,.NOTDEFINED.);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#20));
#20=IFCMAPPEDITEM(#21,#25);
#21=IFCREPRESENTATIONMAP(#5,#22);
#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#30));
#25=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
#30=IFCTRIANGULATEDFACESET(#31,$,.T.,((1,2,3)),$);
#31=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#40=IFCSTYLEDITEM(#30,(#41),$);
#41=IFCSURFACESTYLE('glossy',.POSITIVE.,(#42));
#42=IFCSURFACESTYLERENDERING(#43,$,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);
#43=IFCCOLOURRGB($,0.5,0.4,0.3);
#60=IFCBUILDINGELEMENTPROXY('2occurrenceMapped0000',$,'B',$,$,$,#61,$,.NOTDEFINED.);
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));
#62=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#70));
#70=IFCMAPPEDITEM(#21,#25);
#80=IFCSTYLEDITEM(#70,(#81),$);
#81=IFCSURFACESTYLE('plain',.POSITIVE.,(#82));
#82=IFCSURFACESTYLESHADING(#83,$);
#83=IFCCOLOURRGB($,0.1,0.2,0.9);
ENDSEC;
END-ISO-10303-21;
"#;

fn mesh(express_id: u32, item: Option<u32>, color: [f32; 4]) -> MeshData {
    let mut m = MeshData::new(express_id, "IfcBuildingElementProxy".into(), vec![], vec![], vec![], color);
    m.geometry_item_id = item;
    m
}

fn style_color(finishes: &ModelFinishes, id: u32) -> [f32; 4] {
    finishes.geometry_styles.get(&id).expect("styled").color
}

#[test]
fn a_mapped_item_reaches_the_finish_of_the_leaf_its_colour_comes_from() {
    let mut finishes = ModelFinishes::from_content(MAPPED.as_bytes());
    let glossy = style_color(&finishes, 30);
    // Item level through the mapped chase: the mesh names the mapped item.
    let f = finishes.finish_for_mesh(&mesh(10, Some(20), glossy)).expect("chased to #30");
    assert!((f.roughness.unwrap() - 0.25).abs() < 1e-6);
    // Element level: no item id at all (the single-mesh fallback).
    let f = finishes.finish_for_mesh(&mesh(10, None, glossy)).expect("element-level #30");
    assert!((f.roughness.unwrap() - 0.25).abs() < 1e-6);
}

#[test]
fn a_colour_only_style_stops_the_walk_instead_of_borrowing_a_deeper_finish() {
    let mut finishes = ModelFinishes::from_content(MAPPED.as_bytes());
    let plain = style_color(&finishes, 70);
    // #70's own shading style wins its colour, exactly as the colour walk
    // stops there, so the glossy leaf under the same map must not lend it
    // its finish.
    assert_eq!(finishes.finish_for_mesh(&mesh(60, Some(70), plain)), None);
    assert_eq!(finishes.finish_for_mesh(&mesh(60, None, plain)), None);
}

#[test]
fn an_element_fallback_needs_the_colour_to_match_its_style() {
    let mut finishes = ModelFinishes::from_content(MAPPED.as_bytes());
    // A mesh of #10 whose colour is not the glossy style's came from a
    // material or a type default: colour-only, so no finish.
    assert_eq!(finishes.finish_for_mesh(&mesh(10, None, [0.8, 0.8, 0.8, 1.0])), None);
    // An unstyled item falls back the same way.
    assert_eq!(finishes.finish_for_mesh(&mesh(10, Some(31), [0.8, 0.8, 0.8, 1.0])), None);
}

#[test]
fn a_file_without_finishes_joins_nothing() {
    let plain = MAPPED.replace("IFCNORMALISEDRATIOMEASURE(0.75)", "$");
    let mut finishes = ModelFinishes::from_content(plain.as_bytes());
    // The glossy style is still a rendering, so it claims #30 with an empty
    // finish; nothing else authors one.
    assert_eq!(finishes.finish_for_mesh(&mesh(10, Some(30), [0.5, 0.4, 0.3, 1.0])), None);
}
