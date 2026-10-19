// SPDX-License-Identifier: MPL-2.0
//! Known caller rejection keeps the original actual transaction executable.
use super::*;
use super::tests::{context, execution, worker};
use super::super::session_tests::router;
use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
use ifc_lite_geometry_runtime::MeshLimits;

#[test]
fn actual_predispatch_rejections_return_the_same_armed_packet_for_corrected_retry() {
    let Some(mut worker)=worker() else {return};
    let Some(mut foreign)=self::worker() else {return};
    let foreign_solid=foreign.create_box([0.;3],[2.;3]).unwrap();
    let (_,context)=context();
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let mut issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let ticket=issued.ticket.clone();let stage=issued.stage.clone();
    let original=execution.pending.as_ref().unwrap().outer;
    let count=issued.operations.len();assert!(count>0);
    let usage=account.usage();
    let rejected=issued.execute(&mut foreign,0.001,15.,MeshLimits::default()).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    issued=rejected.issued.expect("foreign worker rejection returns the original packet");
    for (chord,angle,max_bytes) in [(0.,15.,1024),(f64::NAN,15.,1024),
        (0.001,0.,1024),(0.001,181.,1024),(0.001,f64::INFINITY,1024),(0.001,15.,0)] {
        let rejected=issued.execute(&mut worker,chord,angle,MeshLimits {max_bytes}).unwrap_err();
        assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
        issued=rejected.issued.expect("known numerical limits are correctable");
        assert!(issued.armed);
        assert!(Arc::ptr_eq(&issued.ticket,&ticket));assert!(Arc::ptr_eq(&issued.stage,&stage));
        assert_eq!(issued.operations.len(),count);assert_eq!(stage.load(Ordering::Acquire),ISSUED);
        let pending=execution.pending.as_ref().unwrap();
        assert_eq!(pending.outer,original);assert!(pending.reply.is_some());
        assert_eq!(execution.discharged_count(),0);assert_eq!(account.usage(),usage);
        assert!(worker.retained_owner().incarnation().is_some());
        assert!((foreign.volume(foreign_solid,1e-8).unwrap()-8.).abs()<1e-6);
    }
    let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    assert!(Arc::ptr_eq(&work.ticket,&ticket));assert_eq!(stage.load(Ordering::Acquire),DELIVERED);
    let source=work.realization().expect("actual construction result");
    assert!((worker.volume(source.solid(),1e-8).unwrap()-24.).abs()<1e-6);
    execution.accept(work,&mut decoder,&router).unwrap();
    assert_eq!(stage.load(Ordering::Acquire),ACCEPTED);
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert!(execution.traversal_plan().is_some());
    foreign.release(foreign_solid).unwrap();
}

#[test]
fn abandoning_a_returned_predispatch_packet_cancels_only_its_captured_domain() {
    let Some(mut worker)=worker() else {return};
    let Some(mut foreign)=self::worker() else {return};
    let solid=foreign.create_box([0.;3],[2.;3]).unwrap();
    let (_,context)=context();let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let stage=issued.stage.clone();
    let rejected=issued.execute(&mut worker,0.,15.,MeshLimits::default()).unwrap_err();
    assert!(rejected.issued.is_some());assert_ne!(worker.incarnation(),0);
    drop(rejected);
    assert_eq!(stage.load(Ordering::Acquire),CANCELLED);assert_eq!(worker.incarnation(),0);
    assert!((foreign.volume(solid,1e-8).unwrap()-8.).abs()<1e-6);
    assert_eq!(execution.discharged_count(),0);assert!(execution.pending.as_ref().unwrap().reply.is_some());
    foreign.release(solid).unwrap();
}

#[test]
fn terminal_predispatch_faults_outrank_invalid_limits_and_foreign_workers() {
    use ifc_lite_geometry::resource::{self,Cost,Dimension,ProgramStop};
    for mode in ["cancelled","resource","source"] {
        let Some(mut worker)=worker() else {return};
        let Some(mut foreign)=self::worker() else {return};
        let foreign_solid=foreign.create_box([0.;3],[2.;3]).unwrap();
        let (model,context)=context();let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let limit=100_000;
        let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {work:Some(limit),..Default::default()}));
        let mut execution=account.scope(||execution(&context,&mut decoder,&router));
        let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
        let stage=issued.stage.clone();let outer=execution.pending.as_ref().unwrap().outer;
        let fault=match mode {
            "cancelled"=>{issued.cancellation().cancel();None}
            "source"=>{model.invalidate_source();None}
            _=>{
                let remaining=limit-account.usage().work;
                let fault=account.scope(||resource::charge(Cost {work:remaining+1,..Default::default()})).unwrap_err();
                assert!(matches!(fault,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work));
                Some(fault)
            }
        };
        let usage=account.usage();
        // Both later caller errors are present; neither may conceal a terminal
        // original transaction or return it as a correctable live packet.
        let rejected=issued.execute(&mut foreign,0.,0.,MeshLimits {max_bytes:0}).unwrap_err();
        assert!(rejected.issued.is_none());
        match mode {
            "cancelled"=>assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_))),
            "source"=>assert!(matches!(rejected.reason,RetainedExecutionError::Source)),
            _=>assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(stop) if Some(stop)==fault)),
        }
        assert_eq!(stage.load(Ordering::Acquire),CANCELLED);assert_eq!(worker.incarnation(),0);
        assert_eq!(account.usage(),usage,"terminal admission sends no new numerical work");
        assert_eq!(execution.pending.as_ref().unwrap().outer,outer);
        assert!(execution.pending.as_ref().unwrap().reply.is_some());assert_eq!(execution.discharged_count(),0);
        assert!((foreign.volume(foreign_solid,1e-8).unwrap()-8.).abs()<1e-6);
        foreign.release(foreign_solid).unwrap();
    }
}
