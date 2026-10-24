// SPDX-License-Identifier: MPL-2.0
//! #7955 mutations use genuine runtime completions; no mock receipt authority.
use super::*;
use super::super::{derived_layer_runtime_tests::{with_source,host,limits},layer_oracles};
#[test]
fn j3_sdk_issuance_authority_is_not_matching_numeric_receipts() {
    let Some(mut worker) = super::super::tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    with_source(layer_oracles::TWO,|execution,decoder,router| {
        host(execution,decoder,router,&mut worker);
        let mut completed = execution.issue_layer_partition(decoder,router,&worker).unwrap().execute(&mut worker,limits()).unwrap();
        completed.issued.token = Arc::new(LayerToken { stage:AtomicU8::new(DELIVERED) });
        assert!(execution.accept_layer_partition(completed,decoder,router).is_err(),"J3_AUTHORITY");
        assert!(execution.layer_manifest.is_none());
    });
}
#[test]
fn j3_sdk_missing_last_band_is_never_a_complete_manifest() {
    let Some(mut worker) = super::super::tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    with_source(layer_oracles::TWO,|execution,decoder,router| {
        host(execution,decoder,router,&mut worker);
        let mut completed = execution.issue_layer_partition(decoder,router,&worker).unwrap().execute(&mut worker,limits()).unwrap();
        completed.bands.pop();
        assert!(execution.accept_layer_partition(completed,decoder,router).is_err(),"J3_PARTIAL_COMMIT");
        assert!(execution.layer_manifest.is_none());
        assert!(execution.traversal_plan().unwrap().remaining.contains(&RetainedRequirement::MaterialLayers));
    });
}

#[test]
fn j3_sdk_cancellation_prevents_manifest_and_future_execution() {
    let Some(mut worker) = super::super::tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    with_source(layer_oracles::TWO,|execution,decoder,router| {
        host(execution,decoder,router,&mut worker);
        let packet = execution.issue_layer_partition(decoder,router,&worker).unwrap();
        execution.cancel();
        assert!(packet.execute(&mut worker,limits()).is_err(),"J3_CANCELLED");
        assert!(execution.layer_manifest.is_none());
        assert!(execution.traversal_plan().is_none());
    });
}
