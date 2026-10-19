// SPDX-License-Identifier: MPL-2.0
//! Actual accepted cache effects belong to their captured root, never ambient work.
use super::*;
use crate::program::{GeometryProgram,ProgramError,ProgramReply,RetainedContract};
use crate::program::mapping::{RetainedCache,SharedRetainedCache};
use crate::{Error,GeometryRouter};
use ifc_lite_core::EntityDecoder;
use std::sync::{Arc,Mutex};

const SOURCE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);
#6=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));
#7=IFCREPRESENTATIONMAP(#2,#6);#8=IFCMAPPEDITEM(#7,$);";
const CONTRACT:RetainedContract=RetainedContract {source_epoch:7,source_revision:11};

fn pending_publication(decoder:&mut EntityDecoder<'_>,router:&GeometryRouter,cache:SharedRetainedCache)
    ->(GeometryProgram,ProgramReply) {
    let mut program=GeometryProgram::retained_mapped(&decoder.decode_by_id(8).unwrap(),CONTRACT,router,cache).unwrap();
    let mut constructions=0;
    for _ in 0..100 {
        let request=program.request().unwrap().expect("publication still ahead");
        let (reply,operations)=program.admit_retained_with_inputs(request,router,decoder,None,None).unwrap();
        constructions+=operations.len();
        // The actual merged Publish source reply uses the common mapping/source
        // discriminator. No synthetic reply/cache setter supplies this effect.
        if program.expected_payload==Some(0x1007) {
            assert_eq!(constructions,1,"a real source constructor precedes publication");
            return (program,reply);
        }
        program.accept(reply,router).unwrap();
    }
    panic!("small real map did not reach publication");
}
fn foreign_scope()->(RetainedWalk,WalkScope) {
    let foreign=RetainedWalk::root(900);
    foreign.set_test_work_limit(1);
    let scope=foreign.scope().unwrap();
    assert_eq!(foreign.spent_for_test(),1,"ambient root has no remaining work");
    (foreign,scope)
}
fn work_stop(stop:ProgramStop) {
    assert!(matches!(stop,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work));
}

#[test]
fn mapped_publication_acceptance_charges_captured_root_not_exhausted_foreign_scope() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    let (mut program,reply)=pending_publication(&mut decoder,&router,cache.clone());
    assert!(cache.lock().unwrap().get(7).unwrap().is_none());
    let own=program.retained_walk.as_ref().unwrap().clone();let before=own.spent_for_test();
    let (foreign,scope)=foreign_scope();
    program.accept(reply,&router).unwrap();
    assert_eq!(foreign.spent_for_test(),1);assert_eq!(foreign.check(),Ok(()));
    assert!(own.spent_for_test()>before,"accepted cache copy is actual captured-root work");
    drop(scope);
    let cached=cache.lock().unwrap().get(7).unwrap().expect("actual accepted source publication");
    assert_eq!(cached.len(),1);
    assert!(current().is_none());
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        assert!(operations.is_empty());program.accept(reply,&router).unwrap();
    }
    assert!(program.take_geometry_output().is_ok());
}

#[test]
fn stopped_captured_root_rejects_pending_publication_intact_without_foreign_debit() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    let (mut program,reply)=pending_publication(&mut decoder,&router,cache.clone());
    let own=program.retained_walk.as_ref().unwrap().clone();own.set_test_work_limit(own.spent_for_test());
    let stop=match own.scope() {Err(stop)=>stop,Ok(_)=>panic!("exhausted actual root admission must refuse")};
    let (foreign,scope)=foreign_scope();
    let rejected=program.accept(reply,&router).unwrap_err();
    assert_eq!(rejected.error,ProgramError::TraversalStopped(stop));
    program.validate_reply(&rejected.reply,&router).unwrap();
    assert_eq!(foreign.spent_for_test(),1);assert_eq!(foreign.check(),Ok(()));drop(scope);
    assert!(cache.lock().unwrap().get(7).unwrap().is_none());
    work_stop(stop);
    assert!(matches!(program.finish_retained(),Err(Error::ProgramStopped(actual)) if actual==stop));
    assert!(current().is_none());
}

#[test]
fn publication_copy_refusal_is_terminal_without_a_partial_cache_entry() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    let (mut program,reply)=pending_publication(&mut decoder,&router,cache.clone());
    let own=program.retained_walk.as_ref().unwrap().clone();own.set_test_work_limit(own.spent_for_test());
    // No prior terminal: authentic envelope acceptance is allowed, but its
    // actual source copy cannot consume any work. No request() precheck runs.
    assert_eq!(own.check(),Ok(()));
    program.accept(reply,&router).unwrap();
    let stop=own.check().unwrap_err();work_stop(stop);
    assert!(cache.lock().unwrap().get(7).unwrap().is_none());
    assert!(matches!(program.finish_retained(),Err(Error::ProgramStopped(actual)) if actual==stop));
    assert!(current().is_none());
}

#[test]
fn type_map_finish_labels_use_captured_finite_budget_and_restore_foreign_scope() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_type_map_id(7,CONTRACT);
    while let Some(request)=program.request().unwrap() {
        let (reply,_)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        program.accept(reply,&router).unwrap();
    }
    let own=program.retained_walk.as_ref().unwrap().clone();own.set_test_work_limit(own.spent_for_test()+1);
    let (foreign,scope)=foreign_scope();
    let error=program.finish_retained_type_map(100,1,[1.;4]).unwrap_err();
    assert!(matches!(error,Error::ProgramStopped(stop) if matches!(stop,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work)));
    assert_eq!(foreign.spent_for_test(),1);assert_eq!(foreign.check(),Ok(()));drop(scope);
    assert!(own.check().is_err());assert!(current().is_none());
}

#[test]
fn real_styled_cache_search_debits_every_comparison_in_compatibility() {
    let source=format!("{SOURCE}#17=IFCREPRESENTATIONMAP(#2,#6);#18=IFCMAPPEDITEM(#17,$);");
    let mut decoder=EntityDecoder::new(&source);let mut router=GeometryRouter::new();
    router.enable_output_instancing(Arc::new([(7,(2,8)),(17,(2,18))].into_iter().collect()));
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    let mut own=None;
    for id in [8,18] {
        let mut program=GeometryProgram::retained_styled(&decoder.decode_by_id(id).unwrap(),true,CONTRACT,&router,cache.clone()).unwrap();
        while let Some(request)=program.request().unwrap() {
            let (reply,_)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
            program.accept(reply,&router).unwrap();
        }
        own=program.retained_walk.clone();
        assert!(matches!(program.take_geometry_output().unwrap(),crate::program::inner::GeometryOutput::Retained(values) if values.len()==1));
    }
    // Actual template executions populated two different source-cache entries.
    assert!(cache.lock().unwrap().get_styled(7).unwrap().is_some());
    assert!(cache.lock().unwrap().get_styled(17).unwrap().is_some());
    let own=own.unwrap();own.set_test_work_limit(own.spent_for_test()+2);
    let scope=own.scope().unwrap(); // one work remains for two actual comparisons
    let error=cache.lock().unwrap().get_styled(99).unwrap_err();
    assert!(matches!(error,Error::ProgramStopped(stop) if matches!(stop,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work)));
    drop(scope);
    assert!(own.check().is_err());assert!(current().is_none());
}

#[test]
fn styled_source_publication_refuses_its_actual_cache_comparisons_before_insertion() {
    let source=format!("{SOURCE}#17=IFCREPRESENTATIONMAP(#2,#6);#18=IFCMAPPEDITEM(#17,$);
        #27=IFCREPRESENTATIONMAP(#2,#6);#28=IFCMAPPEDITEM(#27,$);");
    let mut decoder=EntityDecoder::new(&source);let mut router=GeometryRouter::new();
    router.enable_output_instancing(Arc::new([(7,(2,8)),(17,(2,18)),(27,(2,28))].into_iter().collect()));
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    for id in [8,18] {
        let mut program=GeometryProgram::retained_styled(&decoder.decode_by_id(id).unwrap(),true,CONTRACT,&router,cache.clone()).unwrap();
        while let Some(request)=program.request().unwrap() {
            let (reply,_)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
            program.accept(reply,&router).unwrap();
        }
        assert!(program.take_geometry_output().is_ok());
    }
    let mut program=GeometryProgram::retained_styled(&decoder.decode_by_id(28).unwrap(),true,CONTRACT,&router,cache.clone()).unwrap();
    let mut reached=false;
    for _ in 0..100 {
        let request=program.request().unwrap().expect("third template publication ahead");
        let (reply,_)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        // Actual styled Finish source acceptance commits its source template.
        if program.expected_payload==Some(0x104b) {
            let own=program.retained_walk.as_ref().unwrap().clone();
            let before=own.spent_for_test();own.set_test_work_limit(before+1);
            program.accept(reply,&router).unwrap();
            work_stop(own.check().unwrap_err());
            assert_eq!(own.spent_for_test(),before+1,"first comparison admitted, second refused");
            reached=true;break;
        }
        program.accept(reply,&router).unwrap();
    }
    assert!(reached);
    assert!(cache.lock().unwrap().get_styled(7).unwrap().is_some());
    assert!(cache.lock().unwrap().get_styled(17).unwrap().is_some());
    assert!(cache.lock().unwrap().get_styled(27).unwrap().is_none(),"refused template never publishes a partial cache entry");
    assert!(program.finish_retained().is_err());assert!(current().is_none());
}

#[test]
fn source_generated_presentation_history_copy_has_its_own_finite_work_cost() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let cache=Arc::new(Mutex::new(RetainedCache::default()));
    let mut program=GeometryProgram::retained_styled(&decoder.decode_by_id(8).unwrap(),false,CONTRACT,&router,cache).unwrap();
    while let Some(request)=program.request().unwrap() {
        let (reply,_)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        program.accept(reply,&router).unwrap();
    }
    let own=program.retained_walk.as_ref().unwrap().clone();
    let crate::program::inner::GeometryOutput::Retained(values)=program.take_geometry_output().unwrap() else {panic!("actual styled value")};
    assert_eq!(values.len(),1);assert_eq!(values[0].presentation().len(),2);
    let before=own.spent_for_test();
    let admitted=1+values.len() as u64+values[0].placements().len() as u64;
    own.set_test_work_limit(before+admitted);
    let scope=own.scope().unwrap();
    let error=crate::program::retained::copy_values(&values).unwrap_err();
    assert!(matches!(error,Error::ProgramStopped(stop) if matches!(stop,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work)));
    assert_eq!(own.spent_for_test(),before+admitted,"scope/value/placement costs fit; presentation history does not");
    drop(scope);assert!(current().is_none());
}

#[test]
fn validated_nested_acceptance_envelopes_do_not_spend_remaining_work() {
    let source=format!("{SOURCE}#10=IFCWALL('nested',$,$,$,$,$,#11,$,$);
        #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
        #12=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#8));");
    let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),CONTRACT);
    let mut reached=false;
    for _ in 0..100 {
        let request=program.request().unwrap().expect("real nested constructor ahead");
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        if !operations.is_empty() {
            assert_eq!(operations.len(),1);
            let own=program.retained_walk.as_ref().unwrap().clone();let before=own.spent_for_test();
            own.set_test_work_limit(before);
            // Product -> mapping -> item forwards this authentic constructor
            // reply. No fallible envelope debit may trigger a nested expect.
            program.accept(reply,&router).unwrap();
            assert_eq!(own.spent_for_test(),before);assert_eq!(own.check(),Ok(()));
            reached=true;break;
        }
        program.accept(reply,&router).unwrap();
    }
    assert!(reached);assert!(current().is_none());
    assert!(matches!(program.request(),Err(ProgramError::TraversalStopped(_))),"next real work still respects the exhausted budget");
    assert!(program.finish_retained().is_err());
}
