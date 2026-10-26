// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
mod support;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::block_on;
use std::cell::Cell;
use support::*;

// Refs #7955: direct feature-gated oracle witness. Six real authored products
// reach an inert transport; no peer constructs numerical geometry.
#[test]
fn m1_d_native_driver_caps_restarts_and_never_retries_the_failed_product() {
    let mut text = BOX.to_string();
    for id in 100..105 {
        text = text.replace("ENDSEC;\nEND-ISO", &format!("#{id}=IFCBUILDINGELEMENTPROXY('p{id}',$,$,$,$,#24,#26,$,.NOTDEFINED.);\nENDSEC;\nEND-ISO"));
    }
    let acquired = Cell::new(0usize);
    let mut outcomes = Vec::new();
    let options = ModelOptions {
        max_restarts: 255,
        ..Default::default()
    };
    let summary = block_on(run_model(
        SourceBundle::new(text.into_bytes()),
        &options,
        || {
            acquired.set(acquired.get() + 1);
            Ok(peer())
        },
        |o| outcomes.push(o),
    ))
    .unwrap();
    assert_eq!(
        acquired.get(),
        4,
        "initial worker plus at most three restarts"
    );
    assert_eq!(summary.restarts, 3);
    assert_eq!(summary.candidates, 6);
    assert_eq!(summary.published, 0);
    assert_eq!(summary.by_code.get("worker_fault"), Some(&6));
    let ids: Vec<_> = outcomes
        .iter()
        .map(|o| match o {
            ProductOutcome::Refused { product_id, .. } => *product_id,
            _ => panic!("inert transport cannot publish"),
        })
        .collect();
    assert_eq!(ids, vec![27, 100, 101, 102, 103, 104]);
}

// #7955: independently compare exact output IDs and physical file ordering.
#[test]
fn canonical_jobs_cover_exact_outputs_in_file_order() {
    use std::collections::BTreeSet;
    for text in [
        SOURCE,
        include_str!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc"),
        include_str!("../../geometry/tests/fixtures/mapped_instances_multi_item.ifc"),
        include_str!("../../geometry/tests/fixtures/mapped_instances_site_rotated.ifc"),
        include_str!("../../../tests/fixtures/synthetic-retained/f-b-mapped.ifc"),
    ] {
        let bytes = text.as_bytes();
        let source = SourceBundle::new(bytes.to_vec());
        let jobs = canonical_element_jobs(&source);
        let ids: Vec<_> = jobs.iter().map(|(id, _)| *id).collect();
        let candidates: BTreeSet<_> = ids.iter().copied().collect();
        let exact = ifc_lite_processing::process_geometry(bytes);
        let mut decoder = source.decoder();
        let exact_ids: BTreeSet<_> = exact
            .meshes
            .iter()
            .map(|m| m.express_id)
            .filter(|id| {
                !decoder
                    .decode_by_id(*id)
                    .unwrap()
                    .ifc_type
                    .is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct)
            })
            .collect();
        assert!(
            exact_ids.is_subset(&candidates),
            "exact-only IDs: {:?}",
            exact_ids.difference(&candidates).collect::<Vec<_>>()
        );
        let mut scanner = ifc_lite_core::EntityScanner::new(bytes);
        let mut file_order = Vec::new();
        while let Some((id, _, _, _)) = scanner.next_entity() {
            if candidates.contains(&id) {
                file_order.push(id);
            }
        }
        assert_eq!(ids, file_order);
    }
}

// #7955: completed contract refusals do not spend the replacement-worker budget.
#[test]
fn contract_fault_keeps_one_worker_for_the_next_product() {
    let mut transport = peer();
    transport.contract = true;
    let domain = transport.domain.clone();
    let calls = transport.calls.clone();
    let mut transport = Some(transport);
    let acquired = Cell::new(0);
    let options = ModelOptions {
        ids: Some([10, 20].into_iter().collect()),
        ..Default::default()
    };
    let summary = block_on(run_model(
        SourceBundle::new(SOURCE.as_bytes().to_vec()),
        &options,
        || {
            acquired.set(acquired.get() + 1);
            Ok(transport.take().expect("worker must not be replaced"))
        },
        |outcome| {
            assert!(matches!(
                outcome,
                ProductOutcome::Refused {
                    refusal: RetainedProductRefusal::ContractBreach,
                    ..
                }
            ))
        },
    ))
    .unwrap();
    assert_eq!(acquired.get(), 1);
    assert_eq!(calls.get(), 2);
    assert_eq!(summary.restarts, 0);
    assert!(
        domain.0.get(),
        "product cleanup must not retire a completed contract fault"
    );
}

// #7955: model boundaries do not reacquire a healthy preflight peer. A final
// affine refuses before the first invocation and spends no replacement budget.
#[test]
fn affine_predispatch_and_model_boundaries_keep_the_preflight_worker() {
    let mut transport = peer();
    transport.contract = true;
    let domain = transport.domain.clone();
    let calls = transport.calls.clone();
    let mut worker = Some(transport);
    let acquired = Cell::new(0);
    for (text, id, expected) in [
        (
            include_str!("../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc"),
            74,
            "incomplete",
        ),
        (SOURCE, 10, "contract_breach"),
        (SOURCE, 20, "contract_breach"),
    ] {
        let summary = block_on(run_model_with_worker(
            SourceBundle::new(text.as_bytes().to_vec()),
            &ModelOptions {
                ids: Some([id].into_iter().collect()),
                ..Default::default()
            },
            &mut worker,
            || {
                acquired.set(acquired.get() + 1);
                Ok(peer())
            },
            |outcome, ms| {
                assert!(ms >= 0.);
                assert_eq!(refusal(&[outcome], id).code(), expected);
            },
        ))
        .unwrap();
        assert_eq!(summary.restarts, 0);
        assert_eq!(summary.acquire_ms, 0.);
        assert!(domain.0.get());
        if id == 74 {
            assert_eq!(calls.get(), 0);
        }
    }
    assert_eq!(acquired.get(), 0);
    assert_eq!(calls.get(), 2);
}

#[test]
fn reused_retired_domain_is_discarded_and_replacements_are_bounded_per_model() {
    let transport = peer();
    transport.domain.0.set(false);
    let mut worker = Some(transport);
    let acquired = Cell::new(0);
    let mut text = BOX.to_string();
    for id in 100..105 {
        text = text.replace("ENDSEC;\nEND-ISO", &format!("#{id}=IFCBUILDINGELEMENTPROXY('p{id}',$,$,$,$,#24,#26,$,.NOTDEFINED.);\nENDSEC;\nEND-ISO"));
    }
    let summary = block_on(run_model_with_worker(
        SourceBundle::new(text.into_bytes()),
        &ModelOptions::default(),
        &mut worker,
        || {
            acquired.set(acquired.get() + 1);
            Ok(peer())
        },
        |_, _| {},
    ))
    .unwrap();
    assert_eq!(summary.restarts, 3);
    assert_eq!(acquired.get(), 3);
    assert!(worker.is_none());
}
