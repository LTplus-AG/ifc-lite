// SPDX-License-Identifier: MPL-2.0
//! Real extension unwind and active source-owner boundaries in the common program.
use super::inner::{GeometryProgram,ProgramError,ProgramRequest,ProgramStage};
use crate::{GeometryRouter,GeometryProcessor,Mesh,Result,TessellationQuality,PendingDiagnosticState};
use ifc_lite_core::{DecodedEntity,EntityDecoder,IfcSchema,IfcType};
use std::{cell::Cell,rc::Rc};

const SOURCE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#10=IFCBLOCK(#2,1.,2.,3.);";
struct ObservedBlock {calls:Rc<Cell<u32>>,interrupt:bool}
impl GeometryProcessor for ObservedBlock {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcBlock]}
    fn process(&self,item:&DecodedEntity,decoder:&mut EntityDecoder<'_>,schema:&IfcSchema,quality:TessellationQuality)->Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        let reached=decoder.decode_by_id(item.id)?;
        assert_eq!(reached.ifc_type,IfcType::IfcBlock);
        if self.interrupt {panic!("selected block extension interrupted")}
        crate::processors::BlockProcessor::new().process(item,decoder,schema,quality)
    }
}
fn extension(program:&mut GeometryProgram,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->ProgramRequest {
    loop {
        let request=program.request().unwrap().expect("extension before completion");
        if request.stage()==ProgramStage::Extension {return request}
        let reply=program.execute(request,router,decoder).unwrap();program.accept(reply,router).unwrap();
    }
}

#[test]
fn panicking_selected_extension_consumes_its_copied_ticket_before_unwind() {
    let calls=Rc::new(Cell::new(0));let mut router=GeometryRouter::new();
    router.register(Box::new(ObservedBlock {calls:calls.clone(),interrupt:true}));
    let mut decoder=EntityDecoder::new(SOURCE);
    let mut program=GeometryProgram::item(decoder.decode_by_id(10).unwrap(),(0.,0.,0.));
    let mut budget=crate::kernel::budget::ElementState::new();let mut reports=PendingDiagnosticState::new();
    budget.with_scope(||reports.with_scope(|| {
        let request=extension(&mut program,&router,&mut decoder);assert_eq!(calls.get(),0);
        let panic=match std::panic::catch_unwind(std::panic::AssertUnwindSafe(||program.execute(request,&router,&mut decoder))) {
            Err(panic)=>panic,
            Ok(_)=>panic!("the original extension panic must propagate"),
        };
        assert_eq!(panic.downcast_ref::<&str>(),Some(&"selected block extension interrupted"));
        assert_eq!(calls.get(),1);
        assert_eq!(program.execute(request,&router,&mut decoder).err(),Some(ProgramError::AlreadyExecuted));
        assert_eq!(calls.get(),1,"a copied ticket cannot re-enter a panicked extension");
        program.cancel_with_reports(&router).unwrap();
    }));
}

#[test]
fn active_decoder_replacement_is_rejected_before_the_selected_extension_runs() {
    let calls=Rc::new(Cell::new(0));let mut router=GeometryRouter::new();
    router.register(Box::new(ObservedBlock {calls:calls.clone(),interrupt:false}));
    let mut decoder=EntityDecoder::new(SOURCE);let mut foreign=EntityDecoder::new(SOURCE);
    let mut program=GeometryProgram::item(decoder.decode_by_id(10).unwrap(),(0.,0.,0.));
    let mut budget=crate::kernel::budget::ElementState::new();let mut reports=PendingDiagnosticState::new();
    budget.with_scope(||reports.with_scope(|| {
        let request=extension(&mut program,&router,&mut decoder);
        assert_eq!(program.execute(request,&router,&mut foreign).err(),Some(ProgramError::WrongOwner));
        assert_eq!(calls.get(),0,"equal source bytes do not authorize a different live decoder");
        let reply=program.execute(request,&router,&mut decoder).unwrap();
        program.accept(reply,&router).unwrap();assert!(program.request().unwrap().is_none());
        assert_eq!(calls.get(),1);
    }));
    let mesh=program.finish().unwrap();assert_eq!(mesh.indices.len()/3,12);
    let (min,max)=mesh.bounds();assert_eq!([max.x-min.x,max.y-min.y,max.z-min.z],[1.,2.,3.]);
}
