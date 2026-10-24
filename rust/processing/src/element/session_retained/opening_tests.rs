// SPDX-License-Identifier: MPL-2.0
//! #7955: actual source/SDK transaction regressions, not final release acceptance.
use super::*;
use super::opening_witness::*;
use super::tests::worker;
use ifc_lite_core::{EntityScanner, SourceBundle};
use crate::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};

pub(super) fn with_source(source: &str, f: impl FnOnce(&mut RetainedProductExecution, &mut EntityDecoder, &GeometryRouter)) {
    let bundle = SourceBundle::new(source.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let mut router = GeometryRouter::with_units(source, &mut decoder);
    router.set_rtc_offset((8.,16.,0.));
    let model = ProductionModel::from_source(bundle.clone());
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source);
    while let Some((id, ty, start, end)) = scanner.next_entity() {
        if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
    }
    let prepass = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index), ..Default::default() });
    let id = if source == TRAP { 72209 } else { 30 };
    let entity = decoder.decode_by_id(id).unwrap();
    let job = ElementMeshJob { id, ifc_type: entity.ifc_type.clone(), entity: &entity,
        kind: ElementJobKind::Product, element_color: None, metadata: None };
    let mut execution = RetainedProductExecution::begin(&job, &context, &MeshProductionOptions::default(), &mut decoder, &router).unwrap();
    f(&mut execution, &mut decoder, &router);
}
#[test]
fn j2_sdk_ordered_overlapping_and_repeated_multipart_source_oracles() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    for (source, parts, expected) in [(OVERLAP.to_owned(),1,3), (reference_source(),1,2), (repeated_mapped_source(),2,8), (translated_source(),1,3)] {
        let oracle = oracle(&source);
        with_source(&source, |execution, decoder, router| {
            let mut cuts = 0;
            let mut total = 0.;
            while let Some(issued) = execution.issue_next(decoder, router, &worker).unwrap() {
                let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
                if let RealizationKind::Boolean(value) = &work.realizations[0].kind {
                    cuts += 1;
                    let volume = worker.volume(value.solid(),1e-8).unwrap();
                    oracle.assert_stage(cuts, volume);
                    if cuts % (expected / parts) == 0 {
                        total += volume;
                        oracle.assert_mesh(&value.mesh().positions, &value.mesh().indices, value.world_from_evaluation());
                    }
                }
                execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}",r.reason));
                assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
            }
            assert_eq!(cuts, expected, "J2_ORDERED_CUTS");
            assert!((total-oracle.total).abs()<1e-6);
            let plan = execution.traversal_plan().unwrap();
            assert_eq!(plan.values.len(),parts);
            assert_eq!(plan.opening_completion.as_ref().unwrap().accepted_cuts(), expected as u64);
            assert!(!plan.remaining.contains(&RetainedRequirement::OpeningClosure));
            assert!(plan.remaining.contains(&RetainedRequirement::PersistentFaces));
            execution.validate_witness().unwrap();
        });
    }
}
#[test]
fn j2_sdk_malformed_opening_aborts_without_uncut_fallback() {
    let Some(mut worker) = worker() else { return };
    let source = OVERLAP.replace("'SweptSolid',(#66)","'SweptSolid',(#999)");
    with_source(&source, |execution, decoder, router| {
        let mut failed = false;
        for _ in 0..128 {
            match execution.issue_next(decoder, router, &worker) {
                Err(_) => { failed = true; break; }
                Ok(None) => break,
                Ok(Some(issued)) => {
                    let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                    execution.accept(work,decoder,router).unwrap_or_else(|r| panic!("{}",r.reason));
                }
            }
        }
        assert!(failed,"J2_MALFORMED_REPORT");
        assert!(execution.traversal_plan().is_none());
        assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
    });
}
#[test]
fn j2_sdk_authenticated_empty_stops_unreachable_opening_decode_but_refuses_removal() {
    let Some(mut worker) = worker() else { return };
    for (source, unreachable) in [
        (empty_host_source(),46),
        (OVERLAP.replace("'SweptSolid',(#46)","'SweptSolid',(#26)"),66),
    ] {
    with_source(&source, |execution, decoder, router| {
        let error = loop {
            match execution.issue_next(decoder,router,&worker) {
                Err(error) => break error,
                Ok(None) => panic!("unproved whole-product removal"),
                Ok(Some(issued)) => {
                    let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                    execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
                }
            }
        };
        assert!(matches!(error, RetainedExecutionError::Unsupported(message) if message.contains("protection policy")));
        assert!(decoder.get_cached(unreachable).is_none(),"J2_EMPTY_LAZY");
        assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
    });
    }
}
#[test]
fn j2_sdk_cancel_after_first_and_last_cut_never_publishes_effects() {
    let Some(mut worker) = worker() else { return };
    for cancel_at in [1,3] {
        with_source(OVERLAP, |execution, decoder, router| {
            let mut cuts = 0;
            while let Some(issued) = execution.issue_next(decoder,router,&worker).unwrap() {
                let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                if matches!(work.realizations[0].kind, RealizationKind::Boolean(_)) { cuts += 1; }
                execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
                if cuts == cancel_at { execution.cancel(); break; }
            }
            assert_eq!(cuts,cancel_at);
            assert!(execution.issue_next(decoder,router,&worker).is_err());
            assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        });
    }
}
#[test]
fn j2_issue3641_authored_backtrack_remains_explicit_release_hold() {
    // The real positive is still REQUIRED. This invariant protects the original
    // source and units while region regularization remains unimplemented.
    let bundle = SourceBundle::new(TRAP.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    assert_eq!(decoder.length_unit_scale(),0.001);
    assert_eq!(decoder.decode_by_id(61271).unwrap().ifc_type, IfcType::IfcExtrudedAreaSolid);
    assert_eq!(decoder.decode_by_id(61272).unwrap().ifc_type, IfcType::IfcArbitraryClosedProfileDef);
    assert_eq!(decoder.decode_by_id(61273).unwrap().ifc_type, IfcType::IfcIndexedPolyCurve);
}

#[test]
fn j2_sdk_swapped_and_replayed_cut_receipts_are_rejected() {
    let Some(mut worker) = worker() else { return };
    with_source(OVERLAP, |execution, decoder, router| {
        while let Some(issued) = execution.issue_next(decoder,router,&worker).unwrap() {
            let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
            if matches!(&work.realizations[0].kind, RealizationKind::Boolean(_)) {
                let replay = RuntimeCompleted { cancellation: work.cancellation.clone(), realizations: work.realizations.clone() };
                let PendingRetainedOperation::Boolean { inputs, .. } = &mut execution.pending.as_mut().unwrap().operations[0] else { panic!("cut") };
                inputs.swap(0,1);
                let rejected = execution.accept(work,decoder,router).expect_err("J2_SWAPPED_RECEIPT");
                let PendingRetainedOperation::Boolean { inputs, .. } = &mut execution.pending.as_mut().unwrap().operations[0] else { panic!("cut") };
                inputs.swap(0,1);
                execution.accept(rejected.work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
                assert!(execution.accept(replay,decoder,router).is_err(),"J2_REPLAYED_RECEIPT");
                assert!(!router.host_consumed_by_void(30));
                return;
            }
            execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
        }
        panic!("no cut reached");
    });
}

#[test]
fn j2_sdk_foreign_cut_receipt_preserves_original_pending_transaction() {
    let Some(mut worker) = worker() else { return };
    with_source(OVERLAP, |left, decoder, router| {
        with_source(OVERLAP, |right, other_decoder, other_router| {
            let first = loop {
                let issued = left.issue_next(decoder,router,&worker).unwrap().unwrap();
                let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                if matches!(&work.realizations[0].kind,RealizationKind::Boolean(_)) { break work; }
                left.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
            };
            let second = loop {
                let issued = right.issue_next(other_decoder,other_router,&worker).unwrap().unwrap();
                let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
                if matches!(&work.realizations[0].kind,RealizationKind::Boolean(_)) { break work; }
                right.accept(work,other_decoder,other_router).unwrap_or_else(|r|panic!("{}",r.reason));
            };
            let foreign = left.accept(second,decoder,router).expect_err("J2_FOREIGN_RECEIPT");
            left.accept(first,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
            right.accept(foreign.work,other_decoder,other_router).unwrap_or_else(|r|panic!("{}",r.reason));
            assert!(!router.host_consumed_by_void(30));
            assert!(!other_router.host_consumed_by_void(30));
        });
    });
}

#[test]
fn j2_sdk_issue3641_positive_chain_requires_profile_region_integration() {
    // Deliberately not ignored and not inverted into an expected-error pass.
    // Parent must integrate the separate profile-region handoff before this is green.
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    with_source(TRAP, |execution, decoder, router| {
        let mut cuts = 0;
        while let Some(issued) = execution.issue_next(decoder,router,&worker).expect("J2_3641_POSITIVE") {
            let work = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).expect("J2_3641_POSITIVE");
            if let RealizationKind::Boolean(value) = &work.realizations[0].kind {
                cuts += 1;
                assert!(!value.is_empty());
                assert!(worker.is_manifold(value.solid()).unwrap());
                assert!(worker.volume(value.solid(),1e-8).unwrap()>0.);
                assert!(value.mesh().indices.iter().all(|&i| (i as usize)<value.mesh().positions.len()/3));
            }
            execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("J2_3641_POSITIVE: {}",r.reason));
        }
        assert_eq!(cuts,3,"J2_3641_POSITIVE");
        execution.validate_witness().unwrap();
    });
}

#[test]
fn j2_sdk_wrong_type_representation_sibling_aborts_entire_closure() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    for (source, malformed, expected_cuts) in representation_sibling_sources() {
        with_source(&source, |execution, decoder, router| {
            let mut refusal = None;
            let mut cuts = 0;
            for _ in 0..128 {
                match execution.issue_next(decoder, router, &worker) {
                    Err(error) => { refusal = Some(error); break; }
                    Ok(None) => break,
                    Ok(Some(issued)) => {
                        let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
                        if let RealizationKind::Boolean(value) = &work.realizations[0].kind {
                            cuts += 1;
                            oracle(OVERLAP).assert_stage(cuts, worker.volume(value.solid(), 1e-8).unwrap());
                        }
                        execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}", r.reason));
                        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
                    }
                }
            }
            if malformed {
                assert!(matches!(refusal, Some(RetainedExecutionError::Protocol(ref message))
                    if message.contains("wrong reached opening representation type")), "J2_REPRESENTATION_TYPE_REPORT: {refusal:?}");
                assert!(execution.traversal_plan().is_none(), "J2_NO_PARTIAL_CLOSURE");
                assert!(execution.validate_witness().is_err());
                assert!(execution.issue_next(decoder, router, &worker).is_err());
            } else {
                assert!(refusal.is_none(), "legitimate non-body sibling: {refusal:?}");
                let plan = execution.traversal_plan().unwrap();
                assert_eq!(plan.values.len(), 1);
                assert_eq!(plan.opening_completion.as_ref().unwrap().accepted_cuts(), 3);
                assert!(!plan.remaining.contains(&RetainedRequirement::OpeningClosure));
                execution.validate_witness().unwrap();
            }
            assert_eq!(cuts, expected_cuts, "J2_REPRESENTATION_SIBLING_CUTS");
            assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
        });
    }
}
