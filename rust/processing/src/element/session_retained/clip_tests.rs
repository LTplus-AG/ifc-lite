// SPDX-License-Identifier: MPL-2.0
//! #7955 SDK definitions: actual issued execution, no fabricated numerical receipts.
use super::*;
use super::adversarial_tests::with_case;
use ifc_lite_testkit::retained_clip::{cases, SOURCE};
#[test]
fn j1_sdk_shared_clip_cases_preserve_volume_bounds_centroid_and_source() {
    for case in cases() {
        with_case(None,&case.source,|execution,decoder,router,worker,_,_| {
            while let Some(issued)=execution.issue_next(decoder,router,worker).unwrap() {
                let completed=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
                execution.accept(completed,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
            }
            execution.validate_witness().unwrap();
            let plan=execution.traversal_plan().unwrap();
            let (logical,receipt)=execution.ledger.iter().find(|(v,_)|v.definition()==plan.values[0].definition()).unwrap();
            let mesh=worker.tessellate(receipt.solid(),0.001,5.,MeshLimits::default()).unwrap();
            ifc_lite_testkit::retained_clip::assert_geometry(&case,&mesh.positions,&mesh.indices,logical.object_frame());
            let volume=worker.volume(receipt.solid(),1e-8).unwrap();
            assert!((volume-case.volume).abs()<=1e-6,"{} SDK volume {volume}",case.name);
            let first=&execution.ledger[0].1;
            assert!((worker.volume(first.solid(),1e-8).unwrap()-24.).abs()<=1e-6,"source lease changed");
        });
    }
}
#[test]
fn j1_sdk_wrong_plane_receipt_is_rejected_without_consumption() {
    with_case(None,SOURCE,|execution,decoder,router,worker,_,_| {
        let issued=execution.issue_next(decoder,router,worker).unwrap().unwrap();
        let completed=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        execution.accept(completed,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        let issued=execution.issue_next(decoder,router,worker).unwrap().unwrap();
        let IssuedRetainedOperation::UnaryClip { input,clip,.. }=&issued.operations[0] else {panic!("clip required")};
        let mut plane=clip.local_plane;plane[2]+=0.25;
        let (side,mode)=super::clip_validation::selectors(clip);
        let wrong=worker.clip_retained_plane(input.operand().native_dependency().unwrap(),plane,side,mode,0.001,5.,MeshLimits::default()).unwrap();
        let mut completed=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        let correct=std::mem::replace(&mut Arc::get_mut(&mut completed.realizations[0]).unwrap().kind,RealizationKind::UnaryClip(Box::new(wrong)));
        let mut rejected=execution.accept(completed,decoder,router).expect_err("wrong plane must refuse");
        assert_eq!(execution.discharged_count(),1);
        assert!(execution.pending.as_ref().unwrap().operations[0].expected().value().evaluated_empty().is_none());
        Arc::get_mut(&mut rejected.work.realizations[0]).unwrap().kind=correct;
        execution.accept(rejected.work,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
    });
}

#[test]
fn j1_sdk_clip_foreign_replay_and_source_invalidation_cannot_accept() {
    with_case(None,SOURCE,|execution,decoder,router,worker,model,_| {
        let first=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        execution.accept(first,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        let issued=execution.issue_next(decoder,router,worker).unwrap().unwrap();
        let mut completed=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        let correct=completed.realizations[0].clone();
        with_case(None,SOURCE,|other,d,r,w,_,_| {
            let first=other.issue_next(d,r,w).unwrap().unwrap().execute(w,0.001,5.,MeshLimits::default()).unwrap();
            other.accept(first,d,r).unwrap_or_else(|e|panic!("{}",e.reason));
            let foreign=other.issue_next(d,r,w).unwrap().unwrap().execute(w,0.001,5.,MeshLimits::default()).unwrap();
            completed.realizations[0]=foreign.realizations[0].clone();
            let rejected=execution.accept(completed,decoder,router).expect_err("foreign clip replay");
            assert_eq!(execution.discharged_count(),1);
            let mut recovered=rejected.work;recovered.realizations[0]=correct;
            model.invalidate_source();
            assert!(execution.accept(recovered,decoder,router).is_err(),"source expired before acceptance");
            assert_eq!(execution.discharged_count(),1);
            assert!(w.retained_owner().incarnation().is_some(),"foreign owner must stay live");
        });
    });
}
#[test]
fn j1_sdk_clip_cancel_after_await_retires_only_captured_domain() {
    use super::runtime::{AsyncRetainedExecutor,Invocation,NumericalLimits,RetainedExecutor};
    use std::future::Future;
    use std::task::{Context,Poll,Waker};
    struct StopAfter<'a> { worker: &'a mut SmlibWorker, original: &'a resource::ExecutionAccount }
    impl RetainedRuntime for StopAfter<'_> {
        type Receipt=RealizationKind;
        fn domain(&self)->RuntimeOwner {self.worker.retained_owner()}
        fn incarnation(&self)->u64 {self.worker.incarnation()}
    }
    impl AsyncRetainedExecutor for StopAfter<'_> {
        async fn invoke(&mut self,call:Invocation<'_,RealizationKind>,limits:NumericalLimits,resources:&OwnedResourceContext)
            ->Result<RealizationKind,RetainedExecutionError> {
            let receipt=RetainedExecutor::invoke(self.worker,call,limits,resources)?;
            self.original.cancel();
            Ok(receipt)
        }
    }
    let original=resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    with_case(Some(&original),SOURCE,|execution,decoder,router,worker,_,_| {
        let first=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        execution.accept(first,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        let other=super::tests::worker().unwrap();
        let owner=worker.retained_owner();
        let issued=execution.issue_next(decoder,router,worker).unwrap().unwrap();
        let mut stop=StopAfter {worker,original:&original};
        let mut future=Box::pin(issued.execute_async(&mut stop,NumericalLimits {chord_metres:0.001,angle_degrees:5.,max_bytes:16<<20}));
        let mut cx=Context::from_waker(Waker::noop());
        let Poll::Ready(result)=future.as_mut().poll(&mut cx) else {panic!("native receipt should settle")};
        let rejected=result.err().expect("clip cancellation after numerical completion must refuse");
        assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert!(rejected.issued.is_none());drop(future);
        assert!(owner.incarnation().is_none());assert!(other.retained_owner().incarnation().is_some());
        assert_eq!(execution.discharged_count(),1);
    });
}

#[test]
fn j1_sdk_clip_empty_requires_authenticated_report() {
    with_case(None,&SOURCE.replace("((0.,0.,1.));#201", "((0.,0.,4.));#201"),|execution,decoder,router,worker,_,_| {
        let first=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        execution.accept(first,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        let mut completed=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        assert!(completed.realizations[0].is_empty());
        assert!(worker.is_empty(completed.realizations[0].solid()).unwrap());
        Arc::get_mut(&mut completed.realizations[0]).unwrap().empty=false;
        let mut rejected=execution.accept(completed,decoder,router).expect_err("clip empty report must authenticate");
        assert_eq!(execution.discharged_count(),1);
        Arc::get_mut(&mut rejected.work.realizations[0]).unwrap().empty=true;
        execution.accept(rejected.work,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        assert!(execution.issue_next(decoder,router,worker).unwrap().is_none());
        assert!(execution.traversal_plan().unwrap().values[0].is_empty());
    });
}
