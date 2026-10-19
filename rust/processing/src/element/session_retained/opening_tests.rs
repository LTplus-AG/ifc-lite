// SPDX-License-Identifier: MPL-2.0
//! Actual SDK-gated opening witnesses; UNCOMPILED/UNRUN until admitted qualification.
use super::opening_witness::*;
use super::tests::worker;
use super::value::RealizationKind;
use super::*;
use ifc_lite_geometry_runtime::MeshLimits;

#[test]
fn p2_sdk_issue_2019_original_opening_control_cuts_overlapping_ordered_sources() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    let (_, context) = context(OVERLAP);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, 30, &mut decoder, &router);
    let oracle = oracle(OVERLAP);
    let mut cuts = 0;
    let mut last = None;
    while let Some(issued) = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
    {
        let work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
            work.realizations[0].validate_live().unwrap();
            assert!(!value.is_empty());
            assert!(worker.is_manifold(value.solid()).unwrap());
            last = Some(worker.volume(value.solid(), 1e-8).unwrap());
            cuts += 1;
            oracle.assert_stage(cuts, last.unwrap());
            if cuts == oracle.stages.len() {
                oracle.assert_mesh(&value.mesh().positions, &value.mesh().indices, value.world_from_evaluation());
            }
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert_eq!(cuts, 3);
    let actual=last.unwrap();
    assert!((actual - oracle.total).abs() < 1e-6,
        "actual ordered SDK opening volume={actual:.17}, source analytic oracle={:.17}, cuts={cuts}", oracle.total);
    assert_plan(&execution, 30, 1, 3);
    let fact = execution
        .traversal_plan()
        .unwrap()
        .opening_completion
        .as_ref()
        .unwrap();
    assert_eq!(fact.related_openings(), 3);
    assert!(fact.grouping_deferred());
}
#[test]
fn p2_sdk_repeated_mapped_opening_parts_keep_distinct_occurrences_and_host_styles() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    let source = repeated_mapped_source();
    let (_, context) = context(&source);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, 30, &mut decoder, &router);
    let mut right_slots = Vec::new();
    let mut final_volume = 0.;
    let oracle = oracle(&source);
    let mut cuts = 0;
    while let Some(issued) = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
    {
        if let ifc_lite_geometry::program::RetainedOperationKind::Boolean { inputs, .. } =
            execution.pending.as_ref().unwrap().operations[0]
                .expected()
                .kind()
        {
            right_slots.push(inputs[1].slot());
        }
        let work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
            cuts += 1;
            work.realizations[0].validate_live().unwrap();
            assert!(!value.is_empty());
            assert!(worker.is_manifold(value.solid()).unwrap());
            oracle.assert_stage(cuts, worker.volume(value.solid(), 1e-8).unwrap());
            if cuts % 4 == 0 {
                oracle.assert_mesh(&value.mesh().positions, &value.mesh().indices, value.world_from_evaluation());
                final_volume += worker.volume(value.solid(), 1e-8).unwrap();
            }
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert_eq!(cuts, 8);
    assert!((final_volume - oracle.total).abs() < 1e-6,
        "actual repeated SDK opening volume={final_volume:.17}, source analytic oracle={:.17}, cuts={cuts}", oracle.total);
    assert_eq!(&right_slots[..4], &right_slots[4..]);
    assert_eq!(
        right_slots[..4]
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        4
    );
    assert_plan(&execution, 30, 2, 8);
    let values = &execution.traversal_plan().unwrap().values;
    assert_ne!(values[0].slot(), values[1].slot());
    for (value, id) in values.iter().zip([26, 126]) {
        assert!(value
            .presentation()
            .iter()
            .any(|binding| binding.geometry_id == id));
    }
}
#[test]
fn p2_sdk_empty_host_stops_before_late_opening_body_or_probe_admission() {
    let Some(mut worker) = worker() else { return };
    let source = empty_host_source();
    let (_, context) = context(&source);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, 30, &mut decoder, &router);
    while let Some(issued) = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
    {
        let work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert!(
        decoder.get_cached(46).is_none(),
        "late cutter source must remain unreached"
    );
    assert_plan(&execution, 30, 1, 0);
    let plan = execution.traversal_plan().unwrap();
    assert!(plan.values[0].is_empty());
    assert!(plan.opening_completion.as_ref().unwrap().empty_host());
}
#[test]
fn p2_sdk_stop_after_completed_opening_retains_original_reply_and_prior_ledger() {
    use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let Some(mut worker) = worker() else { return };
    let (_, context) = context(OVERLAP);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution = account.scope(|| execution(&context, 30, &mut decoder, &router));
    let mut cuts = 0;
    loop {
        let issued = execution
            .issue_next(&worker, &mut decoder, &router)
            .unwrap()
            .expect("next original cut");
        let mut work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        if matches!(work.realizations[0].kind(), RealizationKind::Boolean(_)) {
            cuts += 1;
        }
        if cuts == 2 {
            assert_eq!(
                execution
                    .ledger
                    .iter()
                    .filter(|entry| entry.operation.opening_cut().is_some())
                    .count(),
                1,
                "prior completed cut remains owned before later refusal"
            );
            let before = execution.discharged_count();
            let outer = execution.pending.as_ref().unwrap().outer;
            let ticket = work.ticket.clone();
            work.ticket = Arc::new(());
            let rejected = execution.accept(work, &mut decoder, &router).unwrap_err();
            assert!(matches!(
                rejected.reason,
                RetainedExecutionError::Protocol(_)
            ));
            let mut work = rejected.work;
            work.ticket = ticket;
            account.cancel();
            let rejected = execution.accept(work, &mut decoder, &router).unwrap_err();
            assert!(matches!(
                rejected.reason,
                RetainedExecutionError::Stopped(ProgramStop::Cancelled)
            ));
            assert_eq!(execution.discharged_count(), before);
            assert_eq!(execution.pending.as_ref().unwrap().outer, outer);
            assert!(execution.pending.as_ref().unwrap().reply.is_some());
            assert_eq!(
                execution
                    .ledger
                    .iter()
                    .filter(|entry| entry.operation.opening_cut().is_some())
                    .count(),
                1
            );
            assert!(execution.traversal_plan().is_none());
            rejected.work.realizations[0].validate_live().unwrap();
            break;
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
}
#[test]
fn p2_sdk_issue_3641_actual_voiding_feature_chain_preserves_index_and_closed_solid_invariants() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    let (_, context) = context(TRAP);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, 72209, &mut decoder, &router);
    let mut cuts = 0;
    while let Some(issued) = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
    {
        let work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
            assert!(worker.is_manifold(value.solid()).unwrap());
            assert!(worker.volume(value.solid(), 1e-8).unwrap() > 0.);
            assert!(value
                .mesh()
                .indices
                .iter()
                .all(|&index| (index as usize) < value.mesh().positions.len() / 3));
            cuts += 1;
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert_eq!(cuts, 3);
    assert_plan(&execution, 72209, 1, cuts);
}

#[test]
fn p2_sdk_mixed_reference_opening_keeps_original_no_cutter_eligibility() {
    let Some(mut worker) = worker() else { return };
    let source = reference_source();
    let (_, context) = context(&source);
    let mut decoder = context.source().unwrap().decoder();
    let router = router(&mut decoder);
    let mut execution = execution(&context, 30, &mut decoder, &router);
    let oracle=oracle(&source);
    let mut cuts = 0;
    let mut last = None;
    while let Some(issued) = execution
        .issue_next(&worker, &mut decoder, &router)
        .unwrap()
    {
        let work = issued
            .execute(&mut worker, 0.00001, 15., MeshLimits::default())
            .unwrap();
        if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
            work.realizations[0].validate_live().unwrap();
            assert!(!value.is_empty());
            assert!(worker.is_manifold(value.solid()).unwrap());
            last = Some(worker.volume(value.solid(), 1e-8).unwrap());
            cuts += 1;
            oracle.assert_stage(cuts, last.unwrap());
            if cuts == oracle.stages.len() {
                oracle.assert_mesh(&value.mesh().positions, &value.mesh().indices, value.world_from_evaluation());
            }
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert_eq!(cuts, 2);
    let actual=last.unwrap();
    assert!((actual - oracle.total).abs() < 1e-6,
        "actual Reference-filtered SDK opening volume={actual:.17}, source analytic oracle={:.17}, cuts={cuts}", oracle.total);
    assert!(decoder.get_cached(46).is_none());
    assert_plan(&execution, 30, 1, 2);
}

#[test]
fn p2_sdk_no_related_empty_common_parts_reports_sealed_empty_and_keeps_context_lazy() {
    let Some(mut worker)=worker() else {return};
    let source=empty_host_source();let (model,_indexed_context)=context(&source);
    // Exercise the public common VoidedParts entry with an absent effective
    // void index, as required by callers that explicitly suppress openings.
    let context=model.snapshot(super::super::OwnedMeshProductionData::default());
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,30,&mut decoder,&router);
    execution.state.stage=Stage::VoidedParts;
    let mut actual_empty=0;
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
        if let RealizationKind::Boolean(value)=work.realizations[0].kind() {
            assert!(value.is_empty());actual_empty+=1;
        }
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert_eq!(actual_empty,1);assert_plan(&execution,30,1,0);
    let plan=execution.traversal_plan().unwrap();assert!(plan.values[0].is_empty());
    let fact=plan.opening_completion.as_ref().unwrap();assert!(fact.empty_host());
    assert_eq!(fact.related_openings(),0);assert!(!fact.grouping_deferred());
    assert!(decoder.get_cached(50).is_none());assert!(decoder.get_cached(46).is_none());assert!(decoder.get_cached(999).is_none());
}
