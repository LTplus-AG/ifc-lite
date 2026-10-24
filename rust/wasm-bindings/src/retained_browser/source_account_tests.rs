// SPDX-License-Identifier: MPL-2.0
//! #7955 R2: actual Worker backing admission, cumulative copies and shared roots.
use super::{bridge::tests::{request, RECTANGLE}, BrowserWorker, receipt::BrowserReceipt};
use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, OwnedResourceContext, ResourceLimits};
use ifc_lite_processing::element::runtime::{AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt};
use wasm_bindgen_test::*;
fn limits() -> NumericalLimits {
    NumericalLimits { chord_metres: 0.001, angle_degrees: 5., max_bytes: 16 << 20 }
}
fn account(limits: ResourceLimits) -> (ExecutionAccount, OwnedResourceContext) {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(limits));
    let captured = account.scope(OwnedResourceContext::capture_current);
    (account, captured)
}
async fn refuse(limits_account: ResourceLimits) {
    let mut worker = BrowserWorker::new().unwrap();
    worker.require_source_faces();
    let request = request(RECTANGLE, &worker).with_source_contract(0, 1).unwrap();
    let (account, captured) = account(limits_account);
    let result = worker.invoke(Invocation::Construction(&request), limits(), &captured).await;
    assert!(result.is_err(), "J5_R2 source backing must refuse before Rust copy");
    let terminal = account.check().unwrap_err();
    assert_eq!(captured.check(), Err(terminal), "original source account keeps terminal refusal");
    assert_eq!(worker.incarnation(), 0, "failed retained copy retires its captured Worker");
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_source_low_live_account_refuses_backing() {
    refuse(ResourceLimits { live_bytes: Some(1024), ..Default::default() }).await;
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_source_low_copy_account_refuses_backing() {
    refuse(ResourceLimits { copy_bytes: Some(1), ..Default::default() }).await;
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_multiple_affine_backing_follows_shared_proof_lifetime() {
    let mut worker = BrowserWorker::new().unwrap();
    worker.require_source_faces();
    worker.qualify_dependencies().await.unwrap();
    let request = request(RECTANGLE, &worker).with_source_contract(0, 1).unwrap();
    let (account, captured) = account(ResourceLimits::default());
    let source = worker.invoke(Invocation::Construction(&request), limits(), &captured).await.unwrap();
    let baseline = account.usage();
    let matrix = [-2.,0.,0.,0., 0.,3.,0.,0., 0.,0.,0.5,0., 7.,-1.,2.,1.];
    let first = worker.invoke(Invocation::Affine { input: &source, column_major: matrix }, limits(), &captured).await.unwrap();
    let once = account.usage();
    let second = worker.invoke(Invocation::Affine { input: &source, column_major: matrix }, limits(), &captured).await.unwrap();
    let twice = account.usage();
    let BrowserReceipt::Affine(copy) = &second else { panic!("affine receipt") };
    let proof = copy.source_correspondence.as_ref().unwrap().clone();
    let held_roots = (proof.triangle_roots().len() * 4) as u64;
    assert!(held_roots > 0);
    assert!(twice.live_bytes > once.live_bytes && once.live_bytes > baseline.live_bytes);
    assert!(twice.copy_bytes > once.copy_bytes && once.copy_bytes > baseline.copy_bytes,
        "J5_R2 every affine must debit copied backing");
    drop(second);
    let held = account.usage();
    assert!(held.live_bytes < twice.live_bytes, "J5_R2 dropped mesh refunds backing");
    let clone = proof.clone();
    drop(proof);
    assert_eq!(account.usage(), held, "shared proof must not refund prematurely");
    drop(clone);
    assert!(account.usage().live_bytes + held_roots <= held.live_bytes,
        "J5_R2 final proof drop refunds root backing");
    assert_eq!(account.usage().copy_bytes, twice.copy_bytes, "copy allowance is cumulative");
    first.validate_live().unwrap();
    drop(first);
    drop(source);
    assert_eq!(account.usage().live_bytes, 0, "J5_R2 all source backing released");
}
