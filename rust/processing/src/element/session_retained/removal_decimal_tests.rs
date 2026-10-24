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
    assert!(!super::removal_decimal::coframed(&source.decoder(),30,50).unwrap(), "J2_DECIMAL_COFRAME");
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
            assert!(matches!(refusal, Some(RetainedExecutionError::Unsupported(message))
                if message.contains("protection policy")), "{marker}: {refusal:?}");
            assert!(execution.traversal_plan().is_none());
            assert!(!execution.has_authenticated_opening_removal());
            assert!(execution.issue_next(decoder,router,&worker).is_err());
            assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        });
    }
}
