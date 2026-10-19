// SPDX-License-Identifier: MPL-2.0
//! Actual packet admission and texture-channel invariants.
use super::*;
use std::{sync::Arc, cell::Cell, rc::Rc};
use super::accounted_session_tests::{account, admitted_router};
use super::session_tests::{SOURCE, assert_same, canonical, job, metadata, options};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use ifc_lite_geometry::resource::{self, Cost, ResourceLimits};

struct ChargedExtrusion { calls:Rc<Cell<usize>> }
impl GeometryProcessor for ChargedExtrusion {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity:&DecodedEntity, decoder:&mut EntityDecoder, schema:&IfcSchema,
        quality:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        resource::charge(Cost {work:1,..Cost::default()})?;
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
#[test]
fn dormant_duplicate_and_rejected_actual_packets_do_not_double_charge_or_refund() {
    use super::owned_session::OwnedProductExecution;
    use super::session_protocol::{WorkError,WorkEmitter};
    let model=ProductionModel::new();
    let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=EntityDecoder::new(SOURCE);
    let mut router=admitted_router(&mut decoder);
    let calls=Rc::new(Cell::new(0));
    router.register(Box::new(ChargedExtrusion {calls:calls.clone()}));
    let entity=decoder.decode_by_id(10).unwrap();
    let expected=canonical(10,false);
    let account=account(ResourceLimits::default());
    account.scope(|| {
        let mut execution=OwnedProductExecution::new(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router).unwrap();
        let mut request=execution.request().unwrap().unwrap();
        let dormant=account.usage();
        assert_eq!(execution.request().unwrap_err(),WorkError::Outstanding);
        assert_eq!(account.usage(),dormant);
        let (mut reply,callback_dormant)=loop {
            let before=account.usage();
            let reply=execution.execute(request,&mut decoder,&router).unwrap();
            if calls.get()==1 { break (reply,before) }
            execution.accept(reply,&mut decoder,&router).unwrap();
            request=execution.request().unwrap().expect("actual custom callback remains pending");
        };
        let executed=account.usage();
        assert!(executed.work>callback_dormant.work,"actual canonical callback charged reached work");
        assert_eq!(calls.get(),1);
        assert_eq!(execution.execute(request,&mut decoder,&router).err(),Some(WorkError::AlreadyExecuted));
        assert_eq!(account.usage(),executed);
        assert_eq!(calls.get(),1,"duplicate admission does not reenter the actual callback");
        let emitter=reply.emitter;
        reply.emitter=WorkEmitter::PlainParts;
        let rejected=execution.accept(reply,&mut decoder,&router).unwrap_err();
        assert_eq!(rejected.error,WorkError::WrongEmitter);
        assert_eq!(account.usage(),executed,"rejection neither reruns nor refunds actual work");
        let mut reply=rejected.reply;
        reply.emitter=emitter;
        execution.accept(reply,&mut decoder,&router).unwrap();
        while execution.advance(&mut decoder,&router).unwrap() {}
        let output=execution.finish(&decoder,&router).unwrap();
        assert_same(&output,&expected);
        assert!(account.usage().work>=executed.work);
    });
}

#[test]
fn accounted_real_indexed_texture_preserves_uv_position_pairing_and_frame() {
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
    router.disable_content_dedup();
    decoder.seed_unit_scales(router.unit_scale(),1.); router.set_rtc_offset((8.,16.,0.));
    let context=ProductionModel::new().snapshot(OwnedMeshProductionData {
        texture_index:Arc::new(ifc_lite_geometry::build_texture_index(source.as_bytes(),&mut decoder)),
        ..OwnedMeshProductionData::default() });
    let entity=decoder.decode_by_id(10).unwrap();
    let expected=produce_element_meshes(&job(&entity,&metadata(10)),&context.borrowed(),&options(),&mut decoder,&router);
    assert!(expected.meshes.iter().any(|mesh|mesh.uvs.is_some()),"actual texture constructor must run");
    for _ in 0..2 {
        let account=account(ResourceLimits::default());
        let output=produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router,&account).unwrap();
        assert_same(output.output(),&expected);
        assert_eq!(output.output().meshes[0].uvs,expected.meshes[0].uvs);
        assert_eq!(output.output().meshes[0].texture.as_ref().unwrap().texture_id,200);
        assert!(!output.is_resource_qualified(),"opaque texture/raster allocation remains excluded");
    }
}
