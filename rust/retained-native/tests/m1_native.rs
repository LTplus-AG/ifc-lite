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
