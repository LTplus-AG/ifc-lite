// SPDX-License-Identifier: MPL-2.0
//! Nested item-cache replies authenticate before their enclosing cache effects.
use super::*;
use crate::kernel::budget::ElementState;
use crate::PendingDiagnosticState;
const SOURCE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#10=IFCBLOCK(#2,1.,2.,3.);";
fn execute(control:&mut CacheControl,stage:ProgramStage,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->CacheReply {
    if stage==ProgramStage::Numerical {
        if let Some(ready)=control.take_ready() {ready.execute()}
        else {CacheReply::wrap_child_reply(control.take_child_ready().unwrap().expect("item numerical child").execute())}
    } else {control.execute(router,decoder).unwrap()}
}
fn pending_child(control:&mut CacheControl,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->CacheReply {
    loop {
        let stage=control.poll().unwrap().expect("cache child before completion");
        if stage==ProgramStage::Numerical && matches!(control.action,Some(Action::Child(_))) {
            return execute(control,stage,router,decoder);
        }
        let reply=execute(control,stage,router,decoder);control.accept(reply,router);
    }
}
#[test]
fn cache_foreign_nested_ready_packet_remains_acceptable_by_its_original_owner() {
    fn require_send<T:Send>(){}require_send::<ReadyCacheWork>();
    let router=GeometryRouter::new();let mut decoder=EntityDecoder::new(SOURCE);
    let item=decoder.decode_by_id(10).unwrap();
    let mut first=CacheControl::new(item.clone(),(0.,0.,0.));let mut second=CacheControl::new(item,(0.,0.,0.));
    let mut budget=ElementState::new();let mut diagnostics=PendingDiagnosticState::new();
    budget.with_scope(||diagnostics.with_scope(|| {
        let first_reply=pending_child(&mut first,&router,&mut decoder);
        let second_reply=pending_child(&mut second,&router,&mut decoder);
        assert_eq!(first.validate_reply(&second_reply,&router),Err(ProgramError::StaleRequest));
        assert_eq!(first.validate_reply(&first_reply,&GeometryRouter::new()),Err(ProgramError::WrongOwner));
        first.validate_reply(&first_reply,&router).unwrap();second.validate_reply(&second_reply,&router).unwrap();
        first.accept(first_reply,&router);second.accept(second_reply,&router);
        for control in [&mut first,&mut second] {
            while let Some(stage)=control.poll().unwrap() {
                let reply=execute(control,stage,&router,&mut decoder);
                control.validate_reply(&reply,&router).unwrap();control.accept(reply,&router);
            }
            let mesh=control.take_output().unwrap();assert_eq!(mesh.indices.len()/3,12);
            let (min,max)=mesh.bounds();assert_eq!([max.x-min.x,max.y-min.y,max.z-min.z],[1.,2.,3.]);
        }
    }));
}
