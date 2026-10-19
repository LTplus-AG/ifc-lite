// SPDX-License-Identifier: MPL-2.0
//! P3 canonical installed-load consumer with actual private module Workers.
use super::*;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);
const SOURCE: &str = include_str!("../../../geometry/tests/fixtures/nested_mapped_item.ifc");
fn api() -> IfcAPI {
    let api=IfcAPI::new();api.set_source_bytes(SOURCE.as_bytes().to_vec());api.bind_source_model().unwrap();api
}
#[wasm_bindgen_test(async)]
async fn p3_canonical_snapshot_nested_mapping_witness_is_not_final_product_output() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    let cancellation=executor.cancellation();
    executor.qualify_numerical_routes().await.unwrap();
    let witness=product.execute(&mut executor,0.001,15.,8_388_608).await.unwrap();
    let witness:serde_json::Value=serde_wasm_bindgen::from_value(witness).unwrap();
    assert_eq!(witness["contract"],"common_product_transaction_only");
    assert_eq!(witness["product_id"],35);assert_eq!(witness["occurrences"],2);
    assert_eq!(witness["final_product_available"],false);
    assert!(witness["remaining_requirements"].as_array().unwrap().len()>=5);
    assert!(product.witness().is_ok());
    cancellation.cancel();assert!(product.witness().is_err(),"actual object-domain retirement invalidates held witness");
}
#[wasm_bindgen_test(async)]
async fn p3_canonical_source_replacement_expires_captured_snapshot_without_rebinding() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let original=product.load.clone();
    api.set_source_bytes(SOURCE.as_bytes().to_vec());api.bind_source_model().unwrap();
    assert!(product.context.validate_source().is_err());
    let current=api.coherent_source.lock().unwrap().clone().unwrap();
    assert!(!Arc::ptr_eq(&original,&current));
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    assert!(product.execute(&mut executor,0.001,15.,8_388_608).await.is_err());
    assert!(product.execution.is_none());assert!(product.router.is_some(),"expired source rejected before transaction admission");
}
#[wasm_bindgen_test(async)]
async fn p3_cancellation_captured_before_executor_async_borrow_prevents_startup() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    let cancellation=executor.cancellation();cancellation.cancel();
    assert!(product.execute(&mut executor,0.001,15.,8_388_608).await.is_err());
    assert!(product.witness().is_err());assert!(product.execution.is_none());
}
