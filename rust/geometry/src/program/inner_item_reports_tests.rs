// SPDX-License-Identifier: MPL-2.0
//! Real refused-face source evidence survives detached numerical ownership.
use super::*;
use ifc_lite_core::EntityDecoder;

const REFUSED: &str = "#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#30));
#30=IFCADVANCEDFACE((),#31,.T.);
#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);";
fn detached(router:&GeometryRouter)->(GeometryProgram,ReadyOperation) {
    let mut decoder=EntityDecoder::new(REFUSED);
    let mut program=GeometryProgram::item(decoder.decode_by_id(1).unwrap(),(0.,0.,0.));
    loop {
        let request=program.request().unwrap().unwrap();
        if request.stage()==ProgramStage::Numerical {
            let ready=program.take_ready(request).unwrap();
            assert!(router.take_unsupported_items().is_empty(), "accepted source reports remain owned");
            return (program,ready);
        }
        let reply=program.execute(request,router,&mut decoder).unwrap();
        program.accept(reply,router).unwrap();
    }
}

fn assert_one_refusal(router:&GeometryRouter) {
    let reports=router.take_unsupported_items();
    assert_eq!(reports.get("IfcAdvancedFace"),Some(&1));
    assert_eq!(reports.len(),1);
}
#[test]
fn abandoned_detached_item_forwards_real_source_refusal_once_on_cancel() {
    let router=GeometryRouter::new();
    let (mut program,ready)=detached(&router);
    drop(ready);
    program.cancel_with_reports(&router).unwrap();
    assert_one_refusal(&router);
    program.cancel_with_reports(&router).unwrap();
    assert!(router.take_unsupported_items().is_empty());
}
#[test]
fn abandoned_executed_reply_retains_only_source_refusal_for_cancel() {
    let router=GeometryRouter::new();
    let (mut program,ready)=detached(&router);
    drop(ready.execute());
    assert!(router.take_unsupported_items().is_empty());
    program.cancel_with_reports(&router).unwrap();
    assert_one_refusal(&router);
}
#[test]
fn rejected_detached_item_reply_keeps_source_log_until_real_accept() {
    let router=GeometryRouter::new();
    let (mut program,ready)=detached(&router);
    let mut decoder=EntityDecoder::new(REFUSED);
    let mut foreign=GeometryProgram::item(decoder.decode_by_id(1).unwrap(),(0.,0.,0.));
    let rejected=foreign.accept(ready.execute(),&router).unwrap_err();
    assert!(router.take_unsupported_items().is_empty());
    program.accept(rejected.reply,&router).unwrap();
    assert_one_refusal(&router);
    program.cancel_with_reports(&router).unwrap();
    assert!(router.take_unsupported_items().is_empty());
}

#[test]
fn private_cancel_leaves_ambient_unchanged_until_explicit_diagnostic_cancel() {
    let _=crate::processors::take_face_refused();
    let router=GeometryRouter::new();
    let (mut program,ready)=detached(&router);
    program.cancel();
    assert!(crate::processors::take_face_refused().is_empty());
    program.cancel_with_reports(&router).unwrap();
    assert_one_refusal(&router);
    drop(ready);
    program.cancel_with_reports(&router).unwrap();
    assert!(crate::processors::take_face_refused().is_empty());
    assert!(router.take_unsupported_items().is_empty());
}

#[test]
fn foreign_cancel_preserves_accepted_source_reports_for_the_bound_router() {
    // Inner-program review: cancellation has the same router authority as accept.
    let router = GeometryRouter::new();
    let foreign = GeometryRouter::new();
    let (mut program, ready) = detached(&router);
    drop(ready);
    assert_eq!(program.cancel_with_reports(&foreign), Err(ProgramError::WrongOwner));
    assert!(foreign.take_unsupported_items().is_empty());
    assert!(router.take_unsupported_items().is_empty());
    program.cancel_with_reports(&router).unwrap();
    assert_one_refusal(&router);
    program.cancel_with_reports(&router).unwrap();
    assert!(router.take_unsupported_items().is_empty());
}
