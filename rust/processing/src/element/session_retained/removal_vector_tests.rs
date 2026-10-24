// SPDX-License-Identifier: MPL-2.0
//! #7955 R2-GRAMMAR: assert whole source-vector authority, including valid controls.
use super::*;
#[test]
fn j2_source_vectors_require_complete_tokens() {
    for (marker, source) in super::opening_witness::vector::cases() {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        let result = super::removal_source::covers(&mut source.decoder(),26,46);
        assert!(matches!(result, Err(RetainedExecutionError::Unsupported(message))
            if message.contains("protection policy")), "J2_VECTOR_COMPLETE {marker}: {result:?}");
    }
    for source in [super::opening_witness::removal_sources().remove(0),super::opening_witness::vector::trivia()] {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        assert!(super::removal_source::covers(&mut source.decoder(),26,46).unwrap(), "J2_VECTOR_TRIVIA");
    }
}

#[test]
fn j2_sdk_vector_suffixes_require_source_policy_refusal() {
    let Some(mut worker) = super::tests::worker() else { return };
    for (marker, source) in super::opening_witness::vector::cases() {
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
