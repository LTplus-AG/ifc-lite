// SPDX-License-Identifier: MPL-2.0
//! Actual module Worker opening witnesses; canonical SDK assets are mandatory.
use super::browser_tests::{volume, worker};
use super::opening_witness::*;
use super::value::RealizationKind;
use super::*;
use wasm_bindgen_test::*;

#[wasm_bindgen_test(async)]
async fn p2_worker_issue_2019_original_control_and_repeated_mapped_openings() {
    let mut worker = worker().await;
    for (source, parts, expected_cuts) in [
        (OVERLAP.to_string(), 1, 3),
        (reference_source(), 1, 2),
        (repeated_mapped_source(), 2, 8),
    ] {
        let (_, context) = context(&source);
        let mut decoder = context.source().unwrap().decoder();
        let router = router(&mut decoder);
        let mut execution = execution(&context, 30, &mut decoder, &router);
        let oracle = exact_volume(&source, 30);
        let mut cuts = 0;
        let mut final_volume = 0.;
        let mut right_slots = Vec::new();
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
                .execute_browser(&mut worker, 0.00001, 15., 8_388_608)
                .await
                .unwrap();
            if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
                assert!(!value.is_empty());
                cuts += 1;
                if cuts % (expected_cuts / parts) == 0 {
                    final_volume += volume(value.mesh());
                }
            }
            execution.accept(work, &mut decoder, &router).unwrap();
        }
        assert_eq!(cuts, expected_cuts);
        assert!((final_volume - oracle).abs() < 1e-6);
        assert_plan(&execution, 30, parts, expected_cuts as u64);
        if parts == 2 {
            for (value, id) in execution
                .traversal_plan()
                .unwrap()
                .values
                .iter()
                .zip([26, 126])
            {
                assert!(value
                    .presentation()
                    .iter()
                    .any(|binding| binding.geometry_id == id));
            }
            assert_eq!(&right_slots[..4], &right_slots[4..]);
            assert_eq!(
                right_slots[..4]
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                4
            );
        }
    }
}
#[wasm_bindgen_test(async)]
async fn p2_worker_actual_empty_host_keeps_opening_source_lazy() {
    let mut worker = worker().await;
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
            .execute_browser(&mut worker, 0.00001, 15., 8_388_608)
            .await
            .unwrap();
        execution.accept(work, &mut decoder, &router).unwrap();
    }
    assert!(decoder.get_cached(46).is_none());
    assert_plan(&execution, 30, 1, 0);
    assert!(execution.traversal_plan().unwrap().values[0].is_empty());
}
#[wasm_bindgen_test(async)]
async fn p2_worker_second_cut_foreign_and_cancelled_receipts_leave_original_pending() {
    use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let mut worker = worker().await;
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
            .unwrap();
        let mut work = issued
            .execute_browser(&mut worker, 0.00001, 15., 8_388_608)
            .await
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
            assert!(execution.traversal_plan().is_none());
            break;
        }
        execution.accept(work, &mut decoder, &router).unwrap();
    }
}
#[wasm_bindgen_test(async)]
async fn p2_worker_issue_3641_original_voiding_feature_chain_preserves_index_and_solid_invariants()
{
    let mut worker = worker().await;
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
            .execute_browser(&mut worker, 0.00001, 15., 8_388_608)
            .await
            .unwrap();
        if let RealizationKind::Boolean(value) = work.realizations[0].kind() {
            assert!(volume(value.mesh()) > 0.);
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
