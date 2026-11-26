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
//! - #50 carries the triangle set #60 directly AND through a glossy-grey-styled
//!   mapped item (#53). The direct body is what renders (`Select::Meshed`
//!   skips the duplicate map), so the grey occurrence must not colour it, nor
//!   lend it a finish.
//!
//! Finishes follow the style the colour came from, never the colour (the
//! source travels with each mesh from the colour decision to the join):
//!
//! - #100 maps the leaf twice through two occurrences with the SAME RGBA but
//!   different finishes (roughness 0.2 at x=0, 0.8 at x=3): each mesh keeps
//!   its own occurrence's finish.
//! - #120 maps it through a glossy teal occurrence (roughness 0.25, x=0) and
//!   an unstyled one (x=3) whose teal comes from the material, the same RGBA:
//!   only the glossy mesh has a finish.

use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{Batching, process, process_geometry, MeshData, ProcessingRequest, ProcessingSink};

const GREY: [f32; 4] = [0.6, 0.65, 0.7, 1.0];
const TEAL: [f32; 4] = [0.0, 0.5, 0.5, 1.0];
const RED: [f32; 4] = [0.8, 0.1, 0.1, 1.0];
const DARK: [f32; 4] = [0.3, 0.3, 0.3, 1.0];

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
#56=IFCSTYLEDITEM(#53,(#57),$);
#57=IFCSURFACESTYLE('Glossy grey',.POSITIVE.,(#58));
#58=IFCSURFACESTYLERENDERING(#59,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);
#59=IFCCOLOURRGB($,0.6,0.65,0.7);
#100=IFCSLAB('6SameColourTwoFinish',$,'Same RGBA, two finishes',$,$,#101,#102,$,.FLOOR.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#105));
#103=IFCMAPPEDITEM(#63,#7);
#104=IFCMAPPEDITEM(#63,#9);
#105=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#103,#104));
#110=IFCSTYLEDITEM(#103,(#111),$);
#111=IFCSURFACESTYLE('Smooth dark',.POSITIVE.,(#112));
#112=IFCSURFACESTYLERENDERING(#113,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.8),$,.NOTDEFINED.);
#113=IFCCOLOURRGB($,0.3,0.3,0.3);
#114=IFCSTYLEDITEM(#104,(#115),$);
#115=IFCSURFACESTYLE('Rough dark',.POSITIVE.,(#116));
#116=IFCSURFACESTYLERENDERING(#117,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.2),$,.NOTDEFINED.);
#117=IFCCOLOURRGB($,0.3,0.3,0.3);
#120=IFCSLAB('7GlossyAndMaterial00',$,'Glossy occurrence, material twin',$,$,#121,#122,$,.FLOOR.);
#121=IFCLOCALPLACEMENT($,#5);
#122=IFCPRODUCTDEFINITIONSHAPE($,$,(#125));
#123=IFCMAPPEDITEM(#63,#7);
#124=IFCMAPPEDITEM(#63,#9);
#125=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#123,#124));
#130=IFCSTYLEDITEM(#123,(#131),$);
#131=IFCSURFACESTYLE('Glossy teal',.POSITIVE.,(#132));
#132=IFCSURFACESTYLERENDERING(#133,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);
#133=IFCCOLOURRGB($,0.,0.5,0.5);
#80=IFCMATERIAL('Teal',$,$);
#81=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#82),#80);
#82=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#83));
#83=IFCSTYLEDITEM($,(#84),$);
#84=IFCSURFACESTYLE('Teal',.POSITIVE.,(#85));
#85=IFCSURFACESTYLERENDERING(#86,0.,$,$,$,$,$,$,.BLINN.);
#86=IFCCOLOURRGB($,0.,0.5,0.5);
#87=IFCRELASSOCIATESMATERIAL('0RelAssocMaterialTeal',$,$,$,(#10,#20,#30,#40,#50,#100,#120),#80);
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
    // #43 (grey) places the leaf at the origin, #44 (unstyled) 3 m along x.
    let [(near, _), (far, _)] = at_origin_and_three_metres(40);
    assert!(approx_eq(near.color, GREY), "the styled occurrence at x=0 must draw grey, got {:?}", near.color);
    assert!(approx_eq(far.color, TEAL), "the unstyled occurrence at x=3 must draw teal, got {:?}", far.color);
}

#[test]
fn a_skipped_mapped_representation_does_not_colour_the_direct_body() {
    let meshes = with_finishes(50);
    assert_eq!(meshes.len(), 1, "only the direct body renders, the mapped duplicate is skipped");
    let (mesh, finish) = &meshes[0];
    assert!(approx_eq(mesh.color, TEAL), "the direct body has no style of its own: expected teal, got {:?}", mesh.color);
    assert_eq!(*finish, None, "the skipped occurrence's glossy grey lends no finish");
}

#[test]
fn two_occurrences_with_the_same_colour_keep_their_own_finishes() {
    let [(near, near_finish), (far, far_finish)] = at_origin_and_three_metres(100);
    assert!(approx_eq(near.color, DARK) && approx_eq(far.color, DARK), "both occurrences draw the same RGBA");
    assert_eq!(roughness(near_finish), Some(0.2), "the occurrence at x=0 keeps its smooth finish");
    assert_eq!(roughness(far_finish), Some(0.8), "the occurrence at x=3 keeps its rough finish");
}

#[test]
fn a_material_colour_equal_to_a_glossy_occurrence_borrows_no_finish() {
    let [(near, near_finish), (far, far_finish)] = at_origin_and_three_metres(120);
    assert!(approx_eq(near.color, TEAL) && approx_eq(far.color, TEAL), "the style and the material are the same RGBA");
    assert_eq!(roughness(near_finish), Some(0.25), "the glossy occurrence keeps its finish");
    assert_eq!(far_finish, None, "the material-coloured occurrence has no style, so no finish");
}

/// Each mesh of the native pass with `Features::finishes`, paired with the
/// finish `on_finishes` announced for it.
#[derive(Default)]
struct Recorder {
    pending: Vec<Option<SpecularMaterial>>,
    instance_finishes: Vec<Option<SpecularMaterial>>,
    meshes: Vec<(MeshData, Option<SpecularMaterial>)>,
}

impl ProcessingSink for Recorder {
    fn on_instance_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.instance_finishes = finishes.to_vec();
    }

    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.pending = finishes.to_vec();
    }

    fn on_batch(&mut self, meshes: &[MeshData], _processed: usize, _total: usize) {
        assert_eq!(self.pending.len(), meshes.len(), "one finish per mesh");
        self.meshes.extend(meshes.iter().cloned().zip(std::mem::take(&mut self.pending)));
    }
}

fn with_finishes(express_id: u32) -> Vec<(MeshData, Option<SpecularMaterial>)> {
    let request = ProcessingRequest::full_pass();
    let features = request.features.finishes(true);
    let mut recorder = Recorder::default();
    process(MAPPED_ITEM_STYLE_IFC.as_bytes(), &request.features(features), &mut recorder);
    recorder.meshes.into_iter().filter(|(mesh, _)| mesh.express_id == express_id).collect()
}

/// The two meshes of a slab whose occurrences sit at x=0 and x=3: exactly
/// one near each, nearest first.
fn at_origin_and_three_metres(express_id: u32) -> [(MeshData, Option<SpecularMaterial>); 2] {
    let mut meshes = with_finishes(express_id);
    assert_eq!(meshes.len(), 2, "two occurrences, two meshes");
    meshes.sort_by(|a, b| world_min_x(&a.0).total_cmp(&world_min_x(&b.0)));
    let xs = [world_min_x(&meshes[0].0), world_min_x(&meshes[1].0)];
    assert!(xs[0].abs() < 1e-6 && (xs[1] - 3.0).abs() < 1e-6, "one mesh at x=0 and one at x=3, got {xs:?}");
    let far = meshes.pop().unwrap();
    [meshes.pop().unwrap(), far]
}

fn roughness(finish: Option<SpecularMaterial>) -> Option<f32> {
    finish.and_then(|f| f.roughness).map(|r| (r * 1000.0).round() / 1000.0)
}

/// The smallest x of a mesh's vertices (positions are placed, relative to `origin`).
fn world_min_x(mesh: &MeshData) -> f64 {
    mesh.positions.chunks_exact(3).map(|p| f64::from(p[0]) + mesh.origin[0]).fold(f64::INFINITY, f64::min)
}

#[test]
fn native_instances_keep_same_colour_occurrence_finishes_10698() {
    // `fast_first` defers the attached styles past the first chunk, so every
    // job goes into that chunk: one-job chunks would mesh the slab after the
    // replay and never see the deferral.
    for fast_first in [false, true] {
        let request = ProcessingRequest::full_pass()
            .instancing(true)
            .batching(Batching::single_chunk().fast_first(fast_first));
        let features = request.features.finishes(true).presentation_layers(false);
        let mut sink = Recorder::default();
        let result = process(MAPPED_ITEM_STYLE_IFC.as_bytes(), &request.features(features), &mut sink);
        assert_eq!(result.instances.len(), sink.instance_finishes.len());
        let mut occurrences: Vec<_> = result.instances.iter().zip(sink.instance_finishes)
            .filter(|(instance, _)| instance.express_id == 100)
            .map(|(instance, finish)| {
                assert!(approx_eq(instance.color, DARK));
                (instance.transform[3], roughness(finish))
            })
            .collect();
        occurrences.sort_by(|a, b| a.0.total_cmp(&b.0));
        let [(near_x, near_finish), (far_x, far_finish)] = occurrences.as_slice() else {
            panic!("expected two slab occurrences, got {occurrences:?}");
        };
        assert!((far_x - near_x - 3.0).abs() < 1e-6);
        assert_eq!((*near_finish, *far_finish), (Some(0.2), Some(0.8)));
    }
}

/// Flat meshes too: a `fast_first` pass defers the attached styles past its first
/// chunk, and every job goes into that chunk here, so the same-colour occurrences
/// of slab #100 must still get their own finishes (#10698, CodeRabbit on 9c25396b2).
#[test]
fn deferred_flat_occurrences_keep_their_own_finishes_10698() {
    let request = ProcessingRequest::full_pass().batching(Batching::single_chunk().fast_first(true));
    let features = request.features.finishes(true).presentation_layers(false);
    let mut recorder = Recorder::default();
    process(MAPPED_ITEM_STYLE_IFC.as_bytes(), &request.features(features), &mut recorder);
    let mut occurrences: Vec<_> = recorder.meshes.into_iter()
        .filter(|(mesh, _)| mesh.express_id == 100)
        .map(|(mesh, finish)| (world_min_x(&mesh), roughness(finish)))
        .collect();
    occurrences.sort_by(|a, b| a.0.total_cmp(&b.0));
    let finishes: Vec<_> = occurrences.iter().map(|(_, finish)| *finish).collect();
    assert_eq!(finishes, [Some(0.2), Some(0.8)], "occurrences {occurrences:?}");
}
