// SPDX-License-Identifier: MPL-2.0
//! Actual common request/ready/accept boundaries over authored mapping DAGs.
use super::*;
use crate::{GeometryProcessor, TessellationQuality};
use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
use ifc_lite_core::IfcSchema;
use std::{cell::Cell,rc::Rc,sync::Arc};

const BASE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);
#11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);
#13=IFCMAPPEDITEM(#12,#3);";
const DAG:&str="#20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#13,#13));
#21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);";

struct Scopes {
    budget:crate::kernel::budget::ElementState,
    pending:crate::PendingDiagnosticState,
    account:ExecutionAccount,
}
impl Scopes {
    fn new()->Self {Self {budget:Default::default(),pending:Default::default(),
        account:ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))}}
    fn run<T>(&mut self,work:impl FnOnce()->T)->T {
        let Self {budget,pending,account}=self;
        budget.with_scope(||pending.with_scope(||account.scope(work)))
    }
}

/// Numerical execution stays in the installing executor's lexical scopes.
/// Send is a dormant ownership invariant, not a scoped-worker transport claim.
fn drive(program:&mut GeometryProgram,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,scopes:&mut Scopes)->usize {
    let item=decoder.decode_by_id(13).unwrap();
    let mut foreign=GeometryProgram::mapped_merged(&item,router).unwrap();
    let mut numerical=0;let mut polls=0;
    while let Some(request)=program.request().unwrap() {
        polls+=1;assert!(polls<512,"small mapping DAG must terminate");
        let cache_before=router.mapped_shared_unique_count();
        let reply=scopes.run(|| {
            if request.stage()==ProgramStage::Numerical {
                numerical+=1;
                let packet=program.take_ready(request).unwrap();
                assert_eq!(program.take_ready(request).err(),Some(ProgramError::AlreadyExecuted));
                packet.execute()
            } else {program.execute(request,router,decoder).unwrap()}
        });
        assert_eq!(router.mapped_shared_unique_count(),cache_before,"execution cannot publish a cache reply effect");
        let rejected=foreign.accept(reply,router).unwrap_err();
        assert_eq!(rejected.error,ProgramError::StaleRequest);
        assert_eq!(router.mapped_shared_unique_count(),cache_before,"rejection cannot publish another program's cache effects");
        scopes.run(||program.accept(rejected.reply,router)).unwrap();
        let cache_after=router.mapped_shared_unique_count();
        assert_eq!(program.execute(request,router,decoder).err(),Some(ProgramError::StaleRequest));
        assert_eq!(router.mapped_shared_unique_count(),cache_after);
    }
    numerical
}

#[test]
fn common_ready_mapping_dag_preserves_occurrences_and_cached_frame_parts() {
    fn require_send<T:Send>(){}
    require_send::<super::super::inner::ReadyOperation>();
    require_send::<GeometryProgram>();
    let source=format!("{BASE}{DAG}");let mut decoder=EntityDecoder::new(&source);
    let mut router=GeometryRouter::new();
    router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    let item=decoder.decode_by_id(22).unwrap();let mut scopes=Scopes::new();
    let mut first=GeometryProgram::mapped_merged(&item,&router).unwrap();
    let first_operations=drive(&mut first,&router,&mut decoder,&mut scopes);
    let first=first.finish_parts().unwrap();
    assert_eq!(first.iter().map(|mesh|mesh.indices.len()/3).sum::<usize>(),24);
    assert!(router.cached_mapped_source(12).is_some());assert!(router.cached_mapped_source(21).is_some());
    let mut cached=GeometryProgram::mapped_merged(&item,&router).unwrap();
    let cached_operations=drive(&mut cached,&router,&mut decoder,&mut scopes);
    let cached=cached.finish_parts().unwrap();
    assert_eq!(cached_operations,2,"cache copy and placement are distinct numerical packets");
    assert!(first_operations>cached_operations);
    assert_eq!(first.len(),cached.len());
    for (first,cached) in first.iter().zip(&cached) {
        assert_eq!(first.positions,cached.positions);assert_eq!(first.indices,cached.indices);
        assert_eq!(first.normals,cached.normals);assert_eq!(first.origin,cached.origin);
        assert_eq!(first.local_bounds,cached.local_bounds);assert_eq!(first.local_to_world,cached.local_to_world);
    }
}

#[test]
fn common_ready_styled_mapping_drives_nested_item_cache_and_range_packets() {
    let source=format!("{BASE}{DAG}");let mut decoder=EntityDecoder::new(&source);
    let mut router=GeometryRouter::new();
    router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    let item=decoder.decode_by_id(22).unwrap();let mut scopes=Scopes::new();
    let mut program=GeometryProgram::mapped_styled(&item,false,&router).unwrap();
    assert!(drive(&mut program,&router,&mut decoder,&mut scopes)>2);
    let output=program.finish_submeshes().unwrap();
    assert_eq!(output.len(),2);
    assert!(output.sub_meshes.iter().all(|sub|sub.geometry_id==10 && sub.mesh.indices.len()==36 && sub.uvs.is_none()));
    let first=&output.sub_meshes[0].mesh;let second=&output.sub_meshes[1].mesh;
    assert_eq!(first.positions,second.positions);assert_eq!(first.origin,second.origin);
    if let (Some(first),Some(second))=(&first.instance_meta,&second.instance_meta) {
        assert_eq!(first.rep_identity,second.rep_identity);
    }
}

struct RepairReached {calls:Rc<Cell<usize>>}
impl GeometryProcessor for RepairReached {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcBlock]}
    fn process(&self,item:&DecodedEntity,decoder:&mut EntityDecoder<'_>,schema:&IfcSchema,quality:TessellationQuality)->Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        let source=decoder.decode_by_id(12).unwrap();let target=decoder.decode_by_id(3).unwrap();
        decoder.inject_shared_cache(&[(999,Arc::new(source)),(998,Arc::new(target))].into_iter().collect());
        crate::processors::BlockProcessor::new().process(item,decoder,schema,quality)
    }
}
#[test]
fn common_mapping_later_source_and_target_wait_for_reached_custom_mutation() {
    let source=format!("{BASE}#30=IFCMAPPEDITEM(#999,#998);
        #40=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#13,#30));
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,#3);");
    let calls=Rc::new(Cell::new(0));let mut router=GeometryRouter::new();
    router.register(Box::new(RepairReached {calls:calls.clone()}));
    router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    let mut decoder=EntityDecoder::new(&source);let item=decoder.decode_by_id(42).unwrap();
    let mut program=GeometryProgram::mapped_merged(&item,&router).unwrap();let mut scopes=Scopes::new();
    drive(&mut program,&router,&mut decoder,&mut scopes);
    let output=program.finish_parts().unwrap();
    assert_eq!(output.iter().map(|mesh|mesh.indices.len()/3).sum::<usize>(),24);
    assert_eq!(calls.get(),1,"the repaired source resolves to the independently completed source cache");
}

#[test]
fn common_mapping_whole_items_fault_prevents_earlier_callback_execution() {
    let source=format!("{BASE}#40=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#9999));
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,#3);");
    let calls=Rc::new(Cell::new(0));let mut router=GeometryRouter::new();
    router.register(Box::new(RepairReached {calls:calls.clone()}));
    router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    let mut decoder=EntityDecoder::new(&source);let item=decoder.decode_by_id(42).unwrap();
    let mut program=GeometryProgram::mapped_merged(&item,&router).unwrap();let mut scopes=Scopes::new();
    assert_eq!(drive(&mut program,&router,&mut decoder,&mut scopes),0);
    assert!(program.finish_parts().is_err());assert_eq!(calls.get(),0);
    assert!(router.cached_mapped_source(41).is_none());
}

fn mapping_reply(control:&mut MappingControl,stage:ProgramStage,router:&GeometryRouter,
    decoder:&mut EntityDecoder<'_>,scopes:&mut Scopes)->MappingReply {
    scopes.run(|| {
        if stage==ProgramStage::Numerical {
            if let Some(ready)=control.take_ready() {ready.execute()}
            else {MappingReply::wrap_child_reply(control.take_child_ready().unwrap().expect("numerical child").execute())}
        } else {control.execute(router,decoder,None).unwrap()}
    })
}
fn pending_nested(control:&mut MappingControl,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,scopes:&mut Scopes)->MappingReply {
    loop {
        let stage=control.poll().unwrap().expect("nested item before completion");
        if stage==ProgramStage::Numerical && matches!(control.action,Some(Action::Child(_))) {
            return mapping_reply(control,stage,router,decoder,scopes);
        }
        let reply=mapping_reply(control,stage,router,decoder,scopes);
        scopes.run(||control.accept(reply,router));
    }
}
fn finish_mapping(control:&mut MappingControl,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,scopes:&mut Scopes)->Vec<Mesh> {
    while let Some(stage)=control.poll().unwrap() {
        let reply=mapping_reply(control,stage,router,decoder,scopes);
        control.validate_reply(&reply,router).unwrap();
        scopes.run(||control.accept(reply,router));
    }
    let GeometryOutput::Parts(parts)=control.take_output().unwrap().unwrap() else {panic!("merged parts")};parts
}
#[test]
fn mapping_recursively_rejects_another_child_packet_before_cache_publication() {
    let mut router=GeometryRouter::new();router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    let mut decoder=EntityDecoder::new(BASE);let item=decoder.decode_by_id(13).unwrap();
    let mut first=MappingControl::merged(&item,&router,10001).unwrap();
    let mut second=MappingControl::merged(&item,&router,10002).unwrap();let mut scopes=Scopes::new();
    let first_reply=pending_nested(&mut first,&router,&mut decoder,&mut scopes);
    let second_reply=pending_nested(&mut second,&router,&mut decoder,&mut scopes);
    assert_eq!(first.validate_reply(&second_reply,&router),Err(ProgramError::StaleRequest));
    assert_eq!(first.validate_reply(&first_reply,&GeometryRouter::new()),Err(ProgramError::WrongOwner));
    assert!(router.cached_mapped_source(12).is_none());
    // Borrowed rejection preserves both linear packets for their real owners.
    second.validate_reply(&second_reply,&router).unwrap();
    first.validate_reply(&first_reply,&router).unwrap();
    scopes.run(||second.accept(second_reply,&router));scopes.run(||first.accept(first_reply,&router));
    for control in [&mut first,&mut second] {
        let parts=finish_mapping(control,&router,&mut decoder,&mut scopes);
        assert_eq!(parts.iter().map(|mesh|mesh.indices.len()/3).sum::<usize>(),12);
    }
    assert_eq!(router.cached_mapped_source(12).unwrap().indices.len()/3,12);
}
