// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: invalid limits are refused before acquiring any numerical worker.
use super::support::*;
use ifc_lite_processing::element::retained_runtime::*;
#[test]
fn invalid_limits_never_dispatch_or_publish() {
    let mut options = ModelOptions::default();
    options.limits.chord_metres = f64::NAN;
    let result = ifc_lite_retained_native::block_on(run_model(
        ifc_lite_core::SourceBundle::new(BOX.as_bytes().to_vec()),
        &options,
        || -> Result<Peer, RuntimeFault> { panic!("must not acquire") },
        |_| panic!("must not publish"),
    ));
    assert_eq!(result.unwrap_err().refusal().0.code(), "contract_breach");
}

// #7955 / #8183: the native zero-incarnation case must be a worker refusal,
// never a source failure attributed to this valid authored extrusion.
#[test]
fn acquired_retired_native_worker_reports_worker_retired() {
    let Some(path) = worker_path() else { return };
    let acquired = std::cell::Cell::new(0);
    let mut outcomes = Vec::new();
    let summary = ifc_lite_retained_native::block_on(run_model(
        ifc_lite_core::SourceBundle::new(BOX.as_bytes().to_vec()),
        &ModelOptions::default(),
        || {
            acquired.set(acquired.get() + 1);
            let worker = ifc_lite_retained_native::NativeWorker::spawn(&path)?;
            worker.domain().retire();
            Ok(worker)
        },
        |outcome| outcomes.push(outcome),
    ))
    .unwrap();
    assert_eq!(acquired.get(), 1);
    assert_eq!(summary.restarts, 0);
    assert_eq!(
        refusal(&outcomes, 27),
        RetainedProductRefusal::WorkerRetired
    );
}
