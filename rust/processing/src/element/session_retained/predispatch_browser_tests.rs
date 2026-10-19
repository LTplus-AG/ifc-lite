// SPDX-License-Identifier: MPL-2.0
//! Actual module-worker recovery uses the same original common transaction.
use super::*;
use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};

#[wasm_bindgen_test(async)]
async fn actual_browser_predispatch_errors_return_the_original_packet_and_retry() {
    let mut worker=worker().await;let mut foreign=self::worker().await;
    let (_,context)=model(13,"");let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let mut issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let ticket=issued.ticket.clone();let stage=issued.stage.clone();
    let original=execution.pending.as_ref().unwrap().outer;let count=issued.operations.len();assert!(count>0);
    let usage=account.usage();
    let rejected=issued.execute_browser(&mut foreign,0.001,15.,8_388_608).await.unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    issued=rejected.issued.expect("foreign worker cannot consume the issued packet");
    for (chord,angle,max_bytes) in [(0.,15.,1024),(f64::NAN,15.,1024),
        (0.001,0.,1024),(0.001,181.,1024),(0.001,f64::INFINITY,1024),(0.001,15.,0)] {
        let rejected=issued.execute_browser(&mut worker,chord,angle,max_bytes).await.unwrap_err();
        assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
        issued=rejected.issued.expect("known limits remain correctable before dispatch");
        assert!(issued.armed);assert!(Arc::ptr_eq(&issued.ticket,&ticket));assert!(Arc::ptr_eq(&issued.stage,&stage));
        assert_eq!(stage.load(Ordering::Acquire),ISSUED);assert_eq!(issued.operations.len(),count);
        assert_eq!(execution.pending.as_ref().unwrap().outer,original);
        assert!(execution.pending.as_ref().unwrap().reply.is_some());
        assert_eq!(execution.discharged_count(),0);assert_eq!(account.usage(),usage);
        assert_ne!(worker.incarnation(),0);assert_ne!(foreign.incarnation(),0);
    }
    let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    assert!(Arc::ptr_eq(&work.ticket,&ticket));assert_eq!(stage.load(Ordering::Acquire),DELIVERED);
    assert!((volume(&work.realization().unwrap().completion().tessellation).abs()-24.).abs()<1e-5);
    execution.accept(work,&mut decoder,&router).unwrap();assert_eq!(stage.load(Ordering::Acquire),ACCEPTED);
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
    // A real independent common transaction on the foreign worker still succeeds.
    let mut foreign_decoder=context.source().unwrap().decoder();let foreign_router=self::router(&mut foreign_decoder);
    let mut foreign_execution=self::execution(&context,&mut foreign_decoder,&foreign_router);
    complete(&mut foreign_execution,&mut foreign,&mut foreign_decoder,&foreign_router).await;
}

#[wasm_bindgen_test(async)]
async fn abandoning_recovered_browser_packet_retires_only_the_captured_worker() {
    let mut worker=worker().await;let mut foreign=self::worker().await;
    let (_,context)=model(13,"");let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();let stage=issued.stage.clone();
    let rejected=issued.execute_browser(&mut worker,0.,15.,8_388_608).await.unwrap_err();
    assert!(rejected.issued.is_some());assert_ne!(worker.incarnation(),0);drop(rejected);
    assert_eq!(stage.load(Ordering::Acquire),CANCELLED);assert_eq!(worker.incarnation(),0);
    assert_ne!(foreign.incarnation(),0);
    let mut other_decoder=context.source().unwrap().decoder();let other_router=self::router(&mut other_decoder);
    let mut other=self::execution(&context,&mut other_decoder,&other_router);
    complete(&mut other,&mut foreign,&mut other_decoder,&other_router).await;
    assert!(execution.pending.as_ref().unwrap().reply.is_some());assert_eq!(execution.discharged_count(),0);
}

#[wasm_bindgen_test(async)]
async fn terminal_browser_predispatch_faults_precede_foreign_worker_and_invalid_limits() {
    use ifc_lite_geometry::resource::{self,Cost,Dimension,ProgramStop};
    for mode in ["cancelled","resource","source"] {
        let mut worker=worker().await;let mut foreign=self::worker().await;
        let (model,context)=model(13,"");let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
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
                assert!(matches!(fault,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work));Some(fault)
            }
        };
        let usage=account.usage();
        let rejected=issued.execute_browser(&mut foreign,0.,0.,0).await.unwrap_err();
        assert!(rejected.issued.is_none());
        match mode {
            "cancelled"=>assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_))),
            "source"=>assert!(matches!(rejected.reason,RetainedExecutionError::Source)),
            _=>assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(stop) if Some(stop)==fault)),
        }
        assert_eq!(stage.load(Ordering::Acquire),CANCELLED);assert_eq!(worker.incarnation(),0);
        assert_eq!(account.usage(),usage);assert_ne!(foreign.incarnation(),0);
        assert_eq!(execution.pending.as_ref().unwrap().outer,outer);
        assert!(execution.pending.as_ref().unwrap().reply.is_some());assert_eq!(execution.discharged_count(),0);
        // Expiring the tested model should not expire a genuinely independent
        // model executed by this still-live foreign module Worker.
        let (_,other_context)=self::model(13,"");
        let mut other_decoder=other_context.source().unwrap().decoder();let other_router=self::router(&mut other_decoder);
        let mut other=self::execution(&other_context,&mut other_decoder,&other_router);
        complete(&mut other,&mut foreign,&mut other_decoder,&other_router).await;
    }
}
