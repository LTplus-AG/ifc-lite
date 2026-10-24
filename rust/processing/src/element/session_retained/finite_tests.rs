// SPDX-License-Identifier: MPL-2.0
//! #7955 finite graph acceptance uses the original shared sealed receipt validators.
use super::*;
use super::adversarial_tests::with_case;
use ifc_lite_testkit::retained_finite_clip::boxed;
#[test]
fn j1_finite_sdk_boundary_receipt_cannot_replay_base_or_foreign_owner() {
    with_case(None,&boxed(),|execution,decoder,router,worker,_,_| {
        let mut base = None;
        loop {
            let issued=execution.issue_next(decoder,router,worker).unwrap().unwrap();
            let boundary=matches!(&issued.operations[0], IssuedRetainedOperation::UnaryClip {clip,..}
                if clip.finite.as_ref().is_some_and(|p| !p.is_base()));
            let mut completed=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
            if !boundary {
                if matches!(&completed.realizations[0].kind,RealizationKind::UnaryClip(_)) {base=Some(completed.realizations[0].clone());}
                execution.accept(completed,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
                continue;
            }
            let accepted=execution.discharged_count();
            let correct=completed.realizations[0].clone();
            completed.realizations[0]=base.unwrap();
            let rejected=execution.accept(completed,decoder,router).expect_err("FINITE_REPLAY base receipt is not a boundary receipt");
            assert_eq!(execution.discharged_count(),accepted);
            let mut recovered=rejected.work;
            with_case(None,&boxed(),|other,d,r,w,_,_| {
                // Match the source stage and coefficients in another owner.
                for _ in 0..accepted {
                    let done=other.issue_next(d,r,w).unwrap().unwrap().execute(w,0.001,5.,MeshLimits::default()).unwrap();
                    other.accept(done,d,r).unwrap_or_else(|e|panic!("{}",e.reason));
                }
                let foreign=other.issue_next(d,r,w).unwrap().unwrap().execute(w,0.001,5.,MeshLimits::default()).unwrap();
                recovered.realizations[0]=foreign.realizations[0].clone();
                let rejected=execution.accept(recovered,decoder,router).expect_err("FINITE_OWNER foreign boundary receipt");
                assert_eq!(execution.discharged_count(),accepted);
                let mut restored=rejected.work; restored.realizations[0]=correct;
                execution.accept(restored,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
                assert!(w.retained_owner().incarnation().is_some());
            });
            break;
        }
        while let Some(issued)=execution.issue_next(decoder,router,worker).unwrap() {
            let done=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
            execution.accept(done,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        }
        execution.validate_witness().unwrap();
    });
}
#[test]
fn j1_finite_sdk_source_expiry_between_components_prevents_publication() {
    with_case(None,&boxed(),|execution,decoder,router,worker,model,_| {
        for _ in 0..2 {
            let done=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
            execution.accept(done,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        }
        let done=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
        model.invalidate_source();
        assert!(execution.accept(done,decoder,router).is_err(),"FINITE_SOURCE_EXPIRED");
        assert!(execution.validate_witness().is_err());
    });
}
#[test]
fn j1_finite_sdk_empty_cell_requires_authenticated_boundary_report() {
    // The box is disjoint from the host. No zero-volume heuristic may replace
    // the actual Empty certificate for the first disjoint boundary clip.
    let source=boxed().replace(".DIFFERENCE.",".INTERSECTION.")
        .replace("((-0.25,-0.5,-0.5))","((4.,-0.5,-0.5))");
    with_case(None,&source,|execution,decoder,router,worker,_,_| {
        let mut observed=false;
        while let Some(issued)=execution.issue_next(decoder,router,worker).unwrap() {
            let mut done=issued.execute(worker,0.001,5.,MeshLimits::default()).unwrap();
            if !observed && done.realizations[0].is_empty() {
                observed=true;
                Arc::get_mut(&mut done.realizations[0]).unwrap().empty=false;
                let mut rejected=execution.accept(done,decoder,router).expect_err("FINITE_EMPTY report must authenticate");
                Arc::get_mut(&mut rejected.work.realizations[0]).unwrap().empty=true;
                done=rejected.work;
            }
            execution.accept(done,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        }
        assert!(observed,"FINITE_EMPTY disjoint box must produce an authenticated empty component");
    });
}

#[test]
fn j1_finite_sdk_original_resource_cancel_between_components_is_terminal() {
    let account=resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    with_case(Some(&account),&boxed(),|execution,decoder,router,worker,_,_| {
        for _ in 0..2 {
            let done=execution.issue_next(decoder,router,worker).unwrap().unwrap().execute(worker,0.001,5.,MeshLimits::default()).unwrap();
            execution.accept(done,decoder,router).unwrap_or_else(|e|panic!("{}",e.reason));
        }
        account.cancel();
        assert!(execution.issue_next(decoder,router,worker).is_err(),"FINITE_CANCEL original account must stop the remaining domain");
        assert!(execution.validate_witness().is_err());
    });
}
