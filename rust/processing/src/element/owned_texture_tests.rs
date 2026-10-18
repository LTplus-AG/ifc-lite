// SPDX-License-Identifier: MPL-2.0
//! Real texture resolution remains attached to the immutable source snapshot.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_tests::{SOURCE,assert_same,job,metadata,options};
use std::sync::Arc;

#[test]
fn resolved_texture_snapshot_retains_vertex_uv_pairing_after_caller_replaces_texture_map() {
    let source=SOURCE.replace("#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);",
        "#13=IFCTRIANGULATEDFACESET(#16,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);\n\
         #16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));\n\
         #200=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'assets/original.png');\n\
         #201=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));\n\
         #202=IFCINDEXEDTRIANGLETEXTUREMAP((#200),#13,#201,$);")
        .replace("#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));",
            "#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));");
    let mut decoder=EntityDecoder::new(&source);
    let mut router=GeometryRouter::with_units(&source,&mut decoder);
    decoder.seed_unit_scales(router.unit_scale(),1.);router.set_rtc_offset((8.,16.,0.));
    let model=ProductionModel::new();
    let mut data=OwnedMeshProductionData {texture_index:Arc::new(ifc_lite_geometry::build_texture_index(source.as_bytes(),&mut decoder)),
        ..OwnedMeshProductionData::default()};
    assert_eq!(data.texture_index.len(),1,"resolve actual IFC indexed texture input");
    let context=model.snapshot(data.clone());
    let entity=decoder.decode_by_id(10).unwrap();
    let expected=produce_element_meshes(&job(&entity,&metadata(10)),&context.borrowed(),&options(),&mut decoder,&router);
    let mut session=OwnedProductExecution::new(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).unwrap();
    let map=Arc::make_mut(&mut data.texture_index).get_mut(&13).unwrap();
    map.texture=ifc_lite_geometry::TextureSource::Image(ifc_lite_geometry::ImageTextureRef {
        url:"assets/replacement.png".into(),repeat_s:false,repeat_t:true});
    let replacement=model.snapshot(data);
    drop(context);drop(model);
    while session.advance(&mut decoder,&router).unwrap() {}
    let actual=session.finish(&decoder,&router).unwrap();
    assert_same(&actual,&expected);
    let mesh=&actual.meshes[0];
    let texture=mesh.texture.as_ref().expect("owned map still supplies real texture attachment");
    assert_eq!(texture.url.as_deref(),Some("assets/original.png"));
    assert_eq!((texture.repeat_s,texture.repeat_t),(true,false));
    assert_eq!(texture.texture_id,200);
    assert_eq!(mesh.uvs,expected.meshes[0].uvs);
    let uvs=mesh.uvs.as_ref().unwrap();
    for (vertex,uv) in mesh.positions.chunks_exact(3).zip(uvs.chunks_exact(2)) {
        let object=[f64::from(vertex[0])+mesh.origin[0]+8.-10.,
            f64::from(vertex[1])+mesh.origin[1]+16.-20.,f64::from(vertex[2])+mesh.origin[2]-30.];
        let candidates=[([0.,0.,0.],[0.,1.]),([1.,0.,0.],[1.,1.]),
            ([0.,1.,0.],[0.,0.]),([0.,0.,1.],[1.,0.])];
        let (_,authored)=candidates.iter().find(|(point,_)|*point==object)
            .unwrap_or_else(||panic!("unexpected real tetrahedron vertex {object:?}"));
        assert_eq!(uv,authored,"positions and UVs must remain paired through RTC and assembly");
    }
    let changed=produce_element_meshes_owned(&job(&entity,&metadata(10)),&replacement,&options(),&mut decoder,&router).unwrap();
    assert_eq!(changed.meshes[0].texture.as_ref().unwrap().url.as_deref(),Some("assets/replacement.png"));
    assert_eq!(actual.meshes[0].positions,changed.meshes[0].positions);
}

#[test]
fn owned_opening_index_still_cuts_real_geometry_after_caller_owners_drop() {
    let source=SOURCE.replace("#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);",
        "#20=IFCOPENINGELEMENT('s',$,'Cut',$,$,#9,#21,$,.OPENING.);");
    let mut decoder=EntityDecoder::new(&source);let mut router=GeometryRouter::with_units(&source,&mut decoder);
    decoder.seed_unit_scales(router.unit_scale(),1.);router.set_rtc_offset((8.,16.,0.));
    let model=ProductionModel::new();
    let context=model.snapshot(OwnedMeshProductionData {void_index:Arc::new([(10,vec![20])].into_iter().collect()),
        ..OwnedMeshProductionData::default()});
    let entity=decoder.decode_by_id(10).unwrap();
    let expected=produce_element_meshes(&job(&entity,&metadata(10)),&context.borrowed(),&options(),&mut decoder,&router);
    let mut session=OwnedProductExecution::new(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).unwrap();
    drop(context);drop(model);
    while session.advance(&mut decoder,&router).unwrap() {}
    let actual=session.finish(&decoder,&router).unwrap();
    assert_same(&actual,&expected);
    assert!((actual.geometry_volume.unwrap()-20.).abs()<1e-5,"24 minus the real 2x4x0.5 opening");
}
