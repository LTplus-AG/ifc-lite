// SPDX-License-Identifier: MPL-2.0
//! #7955 R1: these source predicates must reject before trusting a runtime Empty.
use super::*;
use super::opening_witness::decimal;
use ifc_lite_core::SourceBundle;
#[test]
fn j2_authored_decimal_equality_is_not_decoded_equality() {
    let source = SourceBundle::new(decimal::equality().into_bytes());
    assert!(!super::removal_source::covers(&mut source.decoder(),26,46).unwrap(), "J2_DECIMAL_EQUALITY");
}
#[test]
fn j2_authored_input_cancellation_preserves_uncovered_strip() {
    let source = SourceBundle::new(decimal::cancellation().into_bytes());
    assert!(!super::removal_source::covers(&mut source.decoder(),26,46).unwrap(), "J2_DECIMAL_CANCELLATION");
}
#[test]
fn j2_authored_coframe_is_not_decoded_matrix_equality() {
    let source = SourceBundle::new(decimal::coframe().into_bytes());
    assert!(!super::removal_decimal::coframed(&mut source.decoder(),30,50).unwrap(), "J2_DECIMAL_COFRAME");
}
#[test]
fn j2_sdk_authored_decimal_counterexamples_cannot_authorize_removal() {
    let Some(mut worker) = super::tests::worker() else { return };
    for (marker, source) in decimal::cases() {
        super::opening_tests::with_source(&source, |execution, decoder, router| {
            let mut refusal = None;
            for _ in 0..128 {
                match execution.issue_next(decoder,router,&worker) {
                    Err(error) => { refusal = Some(error); break; }
                    Ok(None) => break,
                    Ok(Some(issued)) => {
                        let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                        execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
                    }
                }
            }
            assert!(matches!(&refusal, Some(RetainedExecutionError::Unsupported(message))
                if message.contains("protection policy")), "{marker}: {refusal:?}");
            assert!(execution.traversal_plan().is_none());
            assert!(!execution.has_authenticated_opening_removal());
            assert!(execution.issue_next(decoder,router,&worker).is_err());
            assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        });
    }
}

#[test]
fn j2_decimal_defaults_schema_limits_and_original_account() {
    use super::opening_witness::removal_sources;
    let valid = removal_sources().remove(0);
    let defaults = valid.replace("#25= IFCAXIS2PLACEMENT3D(#24,#4,#2);", "#25=IFCAXIS2PLACEMENT3D(#24,$,$);")
        .replace("#42= IFCAXIS2PLACEMENT2D(#41,#40);", "#42=IFCAXIS2PLACEMENT2D(#41,$);");
    let source = SourceBundle::new(defaults.into_bytes());
    assert!(super::removal_source::covers(&mut source.decoder(),26,46).unwrap());
    for (from,to) in [
        ("#24,#4,#2)","#24,*,#2)"), ("#24,#4,#2)","#24,#4)"),
        ("#24,#4,#2)","#24,#3,#2)"),
        ("#42= IFCAXIS2PLACEMENT2D(#41,#40)","#42=IFCAXIS2PLACEMENT3D(#41,$,#40)"),
        ("#43,#45,#4,5.)","#43,#45,$,5.)"),
        ("#43,#45,#4,5.)","#43,#45,#4,1.E-19)"),
        ("#43,#45,#4,5.)","#43,#45,#4,1.E19)"),
        ("#43,#45,#4,5.)","#43,#45,#4,9999999999999999999999999999999999999.)"),
    ] {
        let source = SourceBundle::new(valid.replace(from,to).into_bytes());
        assert!(super::removal_source::covers(&mut source.decoder(),26,46).is_err(), "J2_DECIMAL_SCHEMA: {to}");
    }
    for cancelled in [false,true] {
        let source = SourceBundle::new(valid.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(
            resource::ResourceLimits { work: if cancelled { None } else { Some(0) }, ..Default::default() }));
        if cancelled { account.cancel(); }
        let result = account.scope(|| super::removal_source::covers(&mut decoder,26,46));
        assert!(matches!(result,Err(RetainedExecutionError::Stopped(_))),"J2_DECIMAL_PREFLIGHT");
        assert_eq!(account.usage().copy_bytes,0);
        assert!(decoder.get_cached(26).is_none());
    }
}

#[test]
fn j2_decimal_coframe_cycles_defaults_and_cancellation() {
    let valid = super::opening_witness::removal_sources().remove(1);
    let source = SourceBundle::new(valid.as_bytes().to_vec());
    assert!(super::removal_decimal::coframed(&mut source.decoder(),30,50).unwrap());
    let source = SourceBundle::new(valid.replace("#29= IFCLOCALPLACEMENT(#8,#5)", "#29=IFCLOCALPLACEMENT(#29,#5)").into_bytes());
    assert!(super::removal_decimal::coframed(&mut source.decoder(),30,50).is_err());
    let source = SourceBundle::new(valid.replace("#5= IFCAXIS2PLACEMENT3D(#1,#4,#2)", "#5=IFCAXIS2PLACEMENT3D(#1,$,$)").into_bytes());
    assert!(super::removal_decimal::coframed(&mut source.decoder(),30,50).unwrap());
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits::default()));
    account.cancel();
    assert!(matches!(account.scope(||super::removal_decimal::coframed(&mut source.decoder(),30,50)),
        Err(RetainedExecutionError::Stopped(_))));
}

#[test]
fn j2_sdk_cancel_between_empty_and_source_proof_keeps_effects_private() {
    let Some(mut worker) = super::tests::worker() else { return };
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits::default()));
    account.scope(|| super::opening_tests::with_source(&super::opening_witness::removal_sources().remove(0), |execution, decoder, router| {
        loop {
            let issued = execution.issue_next(decoder,router,&worker).unwrap().expect("cut required");
            let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
            let empty = work.realizations.iter().any(|receipt| receipt.is_empty());
            execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
            if empty { break; }
        }
        account.cancel();
        let foreign = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits::default()));
        assert!(matches!(foreign.scope(|| execution.issue_next(decoder,router,&worker)),
            Err(RetainedExecutionError::Stopped(_))), "J2_DECIMAL_ORIGINAL_ACCOUNT");
        assert!(!execution.has_authenticated_opening_removal());
        assert!(execution.traversal_plan().is_none());
        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
    }));
}
