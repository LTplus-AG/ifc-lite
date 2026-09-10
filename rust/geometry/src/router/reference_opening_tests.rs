// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::GeometryRouter;
use crate::Mesh;
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

fn fixture(body: bool, reference: bool, opening_type: &str) -> String {
    let reps = match (body, reference) { (true,true)=>"#31,#32", (true,false)=>"#31", (false,true)=>"#32", _=>unreachable!() };
    format!(r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCDIRECTION((0.,0.,1.));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,10.);
#11=IFCEXTRUDEDAREASOLID(#10,#2,#4,1.);
#12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#11));
#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#20=IFCSLAB('0000000000000000000000',$,'Host',$,$,#3,#13,$,.FLOOR.);
#21=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);
#22=IFCEXTRUDEDAREASOLID(#21,#2,#4,1.);
#23=IFCCARTESIANPOINT((3.,0.,0.));
#24=IFCAXIS2PLACEMENT3D(#23,$,$);
#25=IFCEXTRUDEDAREASOLID(#21,#24,#4,1.);
#31=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#22));
#32=IFCSHAPEREPRESENTATION(#5,'Reference','SweptSolid',(#25));
#33=IFCPRODUCTDEFINITIONSHAPE($,$,({reps}));
#40={opening_type}('0000000000000000000001',$,'Opening',$,$,#3,#33,$,.OPENING.);
#41=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#20,#40);
"#)
}
fn volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|t| {
        let p=[t[0],t[1],t[2]].map(|i| {let i=i as usize*3;[f64::from(mesh.positions[i]),f64::from(mesh.positions[i+1]),f64::from(mesh.positions[i+2])]});
        p[0][0]*(p[1][1]*p[2][2]-p[1][2]*p[2][1])+p[0][1]*(p[1][2]*p[2][0]-p[1][0]*p[2][2])+p[0][2]*(p[1][0]*p[2][1]-p[1][1]*p[2][0])
    }).sum::<f64>().abs()/6.
}
#[test]
fn issue_4433_reference_openings_never_cut_but_mixed_body_still_does() {
    for (body, reference, expected) in [(false,true,100.),(true,false,96.),(true,true,96.)] {
        let content=fixture(body,reference,"IFCOPENINGELEMENT");
        let mut decoder=EntityDecoder::new(&content);
        let router=GeometryRouter::new();
        let host=decoder.decode_by_id(20).unwrap();
        let opening=decoder.decode_by_id(40).unwrap();
        let cutter=router.process_element(&opening,&mut decoder).unwrap();
        assert!((volume(&cutter)-if body {4.} else {0.}).abs()<1e-5,"Reference must not contribute cutter volume");
        let items=router.get_opening_item_meshes_world(&opening,&mut decoder).unwrap();
        assert_eq!(items.len(),usize::from(body),"per-item cutter path must honor the same representation selection");
        let bounds=router.get_opening_item_bounds_with_direction(&opening,&mut decoder).unwrap();
        assert_eq!(bounds.len(),usize::from(body),"fast bounds path must exclude Reference solids");
        let opening_parts=router.process_element_with_submeshes(&opening,&mut decoder).unwrap();
        assert_eq!(opening_parts.sub_meshes.len(),usize::from(body));
        let index=FxHashMap::from_iter([(20,vec![40])]);
        let mesh=router.process_element_with_voids(&host,&mut decoder,&index).unwrap();
        assert!((volume(&mesh)-expected).abs()<1e-4);
        let parts=router.process_element_with_submeshes_and_voids(&host,&mut decoder,&index).unwrap();
        let actual=parts.sub_meshes.iter().map(|part|volume(&part.mesh)).sum::<f64>();
        assert!((actual-expected).abs()<1e-4,"submesh path volume {actual}, expected {expected}");
    }
}
#[test]
fn issue_4433_ordinary_product_reference_rendering_is_unchanged() {
    let content=fixture(false,true,"IFCBUILDINGELEMENTPROXY");
    let mut decoder=EntityDecoder::new(&content);
    let element=decoder.decode_by_id(40).unwrap();
    let mesh=GeometryRouter::new().process_element(&element,&mut decoder).unwrap();
    assert!((volume(&mesh)-4.).abs()<1e-5);
}

#[test]
fn issue_4433_reference_direct_shape_cannot_suppress_mapped_body_cutter() {
    let content=fixture(true,true,"IFCOPENINGELEMENT").replace(
        "#31=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#22));",
        "#31=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#64));\n\
         #61=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#22));\n\
         #62=IFCREPRESENTATIONMAP(#2,#61);\n\
         #63=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\n\
         #64=IFCMAPPEDITEM(#62,#63);");
    let mut decoder=EntityDecoder::new(&content);
    let router=GeometryRouter::new();
    let host=decoder.decode_by_id(20).unwrap();
    let opening=decoder.decode_by_id(40).unwrap();
    let cutter=router.process_element(&opening,&mut decoder).unwrap();
    assert!((volume(&cutter)-4.).abs()<1e-5);
    // Reference is at x=3, whereas the mapped Body remains centred at x=0.
    let min=cutter.positions.chunks_exact(3).map(|p|p[0]).fold(f32::INFINITY,f32::min);
    assert!((f64::from(min)+cutter.origin[0]+1.).abs()<1e-5);
    let index=FxHashMap::from_iter([(20,vec![40])]);
    let parts=router.process_element_with_submeshes_and_voids(&host,&mut decoder,&index).unwrap();
    let actual=parts.sub_meshes.iter().map(|part|volume(&part.mesh)).sum::<f64>();
    assert!((actual-96.).abs()<1e-4);
}
