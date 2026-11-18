// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #10698: an `IfcStyledItem` on an `IfcMappedItem` styles that occurrence of the mapped
//! geometry, and it outranks the element's material appearance, as a styled item
//! on the geometry does. A Revit export writes exactly this: the shared brep in the
//! representation map carries no style, the occurrence's `IfcMappedItem` carries
//! the colour, and the element's `IfcMaterial` has a different colour of its own.
//! Before the fix the mapped item's style was not found, so the element drew in
//! its material colour; on a large slab lying on other elements that made a z-fight
//! between two different colours visible as flicker.
//!
//! All three slabs share one teal material and map one unstyled triangle set:
//!
//! - #10's `IfcMappedItem` #13 is styled grey (#90): it must draw grey.
//! - #20's mapped item is unstyled: the control, it draws the teal material.
//! - #30 maps a second map whose own item is styled red (#94): a style on the
//!   mapped geometry itself keeps winning over the material.
//! - #40 maps the same triangle set twice, once through grey-styled #43 and
//!   once through unstyled #44: each occurrence is coloured by its own mapped
//!   item, so one draws grey and one teal, though both share the leaf #60.
//! - #50 carries the triangle set #60 directly AND through a grey-styled
//!   mapped item (#53). The direct body is what renders (`Select::Meshed`
//!   skips the duplicate map), so the grey occurrence must not colour it.

use ifc_lite_processing::process_geometry;

const GREY: [f32; 4] = [0.6, 0.65, 0.7, 1.0];
const TEAL: [f32; 4] = [0.0, 0.5, 0.5, 1.0];
const RED: [f32; 4] = [0.8, 0.1, 0.1, 1.0];

const MAPPED_ITEM_STYLE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('mapped item style over material fixture'),'2;1');
FILE_NAME('mapped-item-style.ifc','2026-11-18T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0MappedItemStyle00001',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
#8=IFCCARTESIANPOINT((3.,0.,0.));
#9=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#8,1.,$);
#60=IFCTRIANGULATEDFACESET(#61,$,.T.,((1,2,3),(1,3,4)),$);
#61=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.)));
#62=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#60));
#63=IFCREPRESENTATIONMAP(#5,#62);
#64=IFCTRIANGULATEDFACESET(#65,$,.T.,((1,2,3),(1,3,4)),$);
#65=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.)));
#66=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#64));
#67=IFCREPRESENTATIONMAP(#5,#66);
#10=IFCSLAB('1MappedItemStyledGrey',$,'Styled occurrence',$,$,#11,#12,$,.FLOOR.);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#13=IFCMAPPEDITEM(#63,#7);
#14=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#13));
#20=IFCSLAB('2MappedItemUnstyled0',$,'Unstyled occurrence',$,$,#21,#22,$,.FLOOR.);
#21=IFCLOCALPLACEMENT($,#5);
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#23=IFCMAPPEDITEM(#63,#9);
#24=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#23));
#30=IFCSLAB('3MappedGeometryStyled',$,'Styled mapped geometry',$,$,#31,#32,$,.FLOOR.);
#31=IFCLOCALPLACEMENT($,#5);
#32=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));
#33=IFCMAPPEDITEM(#67,#7);
#34=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#33));
#40=IFCSLAB('4MappedItemTwiceShared',$,'Two occurrences of one leaf',$,$,#41,#42,$,.FLOOR.);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#43=IFCMAPPEDITEM(#63,#7);
#44=IFCMAPPEDITEM(#63,#9);
#45=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#43,#44));
#46=IFCSTYLEDITEM(#43,(#91),$);
#50=IFCSLAB('5DirectBodyAndMapped0',$,'Direct body and a skipped map',$,$,#51,#52,$,.FLOOR.);
#51=IFCLOCALPLACEMENT($,#5);
#52=IFCPRODUCTDEFINITIONSHAPE($,$,(#54,#55));
#53=IFCMAPPEDITEM(#63,#7);
#54=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#53));
#55=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#60));
#56=IFCSTYLEDITEM(#53,(#91),$);
#80=IFCMATERIAL('Teal',$,$);
#81=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#82),#80);
#82=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#83));
#83=IFCSTYLEDITEM($,(#84),$);
#84=IFCSURFACESTYLE('Teal',.POSITIVE.,(#85));
#85=IFCSURFACESTYLERENDERING(#86,0.,$,$,$,$,$,$,.BLINN.);
#86=IFCCOLOURRGB($,0.,0.5,0.5);
#87=IFCRELASSOCIATESMATERIAL('0RelAssocMaterialTeal',$,$,$,(#10,#20,#30,#40,#50),#80);
#90=IFCSTYLEDITEM(#13,(#91),$);
#91=IFCSURFACESTYLE('Grey',.POSITIVE.,(#92));
#92=IFCSURFACESTYLERENDERING(#93,0.,$,$,$,$,$,$,.BLINN.);
#93=IFCCOLOURRGB($,0.6,0.65,0.7);
#94=IFCSTYLEDITEM(#64,(#95),$);
#95=IFCSURFACESTYLE('Red',.POSITIVE.,(#96));
#96=IFCSURFACESTYLERENDERING(#97,0.,$,$,$,$,$,$,.BLINN.);
#97=IFCCOLOURRGB($,0.8,0.1,0.1);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-3)
}

fn colours_of(express_id: u32) -> Vec<[f32; 4]> {
    let result = process_geometry(MAPPED_ITEM_STYLE_IFC);
    let colours: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == express_id)
        .map(|m| m.color)
        .collect();
    assert!(!colours.is_empty(), "slab #{express_id} produced no mesh");
    colours
}

#[test]
fn a_style_on_the_mapped_item_outranks_the_material() {
    for colour in colours_of(10) {
        assert!(
            approx_eq(colour, GREY),
            "the mapped item's grey must win over the teal material, got {colour:?}"
        );
    }
}

#[test]
fn an_unstyled_mapped_item_still_takes_the_material() {
    for colour in colours_of(20) {
        assert!(approx_eq(colour, TEAL), "expected the teal material, got {colour:?}");
    }
}

#[test]
fn a_style_on_the_mapped_geometry_still_outranks_the_material() {
    for colour in colours_of(30) {
        assert!(approx_eq(colour, RED), "expected the mapped geometry's red, got {colour:?}");
    }
}

#[test]
fn each_occurrence_of_a_shared_leaf_takes_its_own_style() {
    let colours = colours_of(40);
    assert_eq!(colours.len(), 2, "two occurrences, two sub-meshes: {colours:?}");
    assert!(colours.iter().any(|&c| approx_eq(c, GREY)), "the styled occurrence must draw grey: {colours:?}");
    assert!(colours.iter().any(|&c| approx_eq(c, TEAL)), "the unstyled occurrence must draw teal: {colours:?}");
}

#[test]
fn a_skipped_mapped_representation_does_not_colour_the_direct_body() {
    for colour in colours_of(50) {
        assert!(approx_eq(colour, TEAL), "the direct body has no style of its own: expected teal, got {colour:?}");
    }
}
