// SPDX-License-Identifier: MPL-2.0
//! #7955 R3: malformed authority at nested, containing, and coframe boundaries.
use super::*;
use super::opening_witness::{record,removal_sources};
fn refused<T: std::fmt::Debug>(result: Result<T,RetainedExecutionError>) {
    assert!(matches!(&result,Err(RetainedExecutionError::Unsupported(message))
        if message.contains("protection policy")),"J2_RECORD_COMPLETE: {result:?}");
}
#[test]
fn j2_source_records_and_nested_values_require_complete_authority() {
    for (_, source) in record::cases() {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        refused(super::removal_source::covers(&mut source.decoder(),26,46));
    }
    for id in [23,25,26,42,43,45,46] {
        let source = ifc_lite_core::SourceBundle::new(record::tail(id,"(2.);").into_bytes());
        refused(super::removal_source::covers(&mut source.decoder(),26,46));
    }
    for (_,source) in super::opening_witness::vector::cases() {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        refused(super::removal_source::covers(&mut source.decoder(),26,46));
    }
    for source in [removal_sources().remove(0),record::trivia()] {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        assert!(super::removal_source::covers(&mut source.decoder(),26,46).unwrap(),"J2_RECORD_TRIVIA");
    }
}
#[test]
fn j2_coframe_records_do_not_grant_prefix_authority() {
    for id in [1,2,4,5,8,29,30,49,50] {
        let source = ifc_lite_core::SourceBundle::new(record::tail(id," /*tail*/ (2.);").into_bytes());
        refused(super::removal_decimal::coframed(&mut source.decoder(),30,50));
    }
    let source = ifc_lite_core::SourceBundle::new(record::trivia().into_bytes());
    assert!(super::removal_decimal::coframed(&mut source.decoder(),30,50).unwrap());
}
#[test]
fn j2_body_membership_rejects_record_and_nested_list_tails() {
    for source in [record::tail(30,"(2.);"),record::tail(28,"(2.);"),record::tail(27,"(2.);"),
        removal_sources().remove(0).replace("($,$,(#27))", "($,$,(#27)BOGUS)"),
        removal_sources().remove(0).replace("'SweptSolid',(#26)","'SweptSolid',(#26)BOGUS"),
        removal_sources().remove(0).replace("'Body','SweptSolid',(#26)","'Body'BOGUS,'SweptSolid',(#26)"),
        removal_sources().remove(0).replace("'SweptSolid',(#26)","'SweptSolid',((#26))")] {
        let source = ifc_lite_core::SourceBundle::new(source.into_bytes());
        refused(super::removal_source::body(&mut source.decoder(),30));
    }
    let source = ifc_lite_core::SourceBundle::new(record::trivia().into_bytes());
    assert_eq!(super::removal_source::body(&mut source.decoder(),30).unwrap(),vec![26]);
}

#[test]
fn j2_sdk_record_suffixes_require_source_policy_refusal() {
    let Some(mut worker) = super::tests::worker() else { return };
    let cases = super::opening_witness::record::cases().into_iter().map(|(marker,source)| (marker,source,false))
        .chain(std::iter::once(("J2_RECORD_TRIVIA",super::opening_witness::record::trivia(),true)));
    for (marker, source, valid) in cases {
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
            if valid {
                assert!(refusal.is_none(), "{marker}: {refusal:?}");
                assert!(execution.has_authenticated_opening_removal(), "{marker}");
                execution.validate_witness().unwrap();
                assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
                return;
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
fn j2_relationship_records_and_reference_tokens_require_complete_authority() {
    for (source,valid) in [(record::tail(80,"(2.);"),false),
        (removal_sources().remove(0).replace("$,$,$,#30,#50)","$,$,$,#30,#50BOGUS)"),false),
        (record::trivia(),true)] {
        let bundle = ifc_lite_core::SourceBundle::new(source.into_bytes());
        let model = ProductionModel::from_source(bundle.clone());
        let mut ids = rustc_hash::FxHashMap::default();
        ids.insert(30,vec![50,70,100]);
        let context = model.snapshot(OwnedMeshProductionData {void_index: Arc::new(ids), ..Default::default()});
        let result = super::removal_source::relationships(&context,&mut bundle.decoder(),30);
        if valid { assert_eq!(result.unwrap(),vec![50,70,100]); } else { refused(result); }
    }
}
