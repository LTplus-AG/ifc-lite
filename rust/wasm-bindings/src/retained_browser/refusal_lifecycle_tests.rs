// SPDX-License-Identifier: MPL-2.0
//! #7955: the shared lifecycle running on an actual SMLib module Worker.
use super::BrowserWorker;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;
const CASCADE: &[u8] = include_bytes!("../../../../tests/fixtures/synthetic-retained/refusal-cascade.ifc");

#[wasm_bindgen_test(async)]
async fn retained_browser_refusals_preserve_worker_and_release_objects() {
    let mut native = BrowserWorker::new().unwrap();
    native.qualify().await.unwrap();
    let incarnation = native.incarnation();
    let mut worker = Some(native);
    let mut rows = Vec::new();
    let summary = run_model_with_worker(SourceBundle::new(CASCADE.to_vec()),
        &ModelOptions { max_restarts: 0, ..Default::default() }, &mut worker,
        || panic!("source refusal must not replace the browser Worker"),
        |o, _| rows.push(o)).await.unwrap();
    assert_eq!((summary.candidates, summary.published, summary.restarts), (9,1,0));
    assert_eq!(summary.by_code.get("opening_unsupported"), Some(&4));
    assert_eq!(summary.by_code.get("operation_unsupported"), Some(&4));
    let worker = worker.as_ref().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    assert_eq!(JsFuture::from(worker.owner.driver.live_object_count()).await.unwrap().as_f64(), Some(0.));
    let reused = rows.iter().find_map(|o| match o {
        ProductOutcome::Published(s) if s.product_id == 104 => Some(s), _ => None,
    }).expect("#104 must publish after four opening refusals");
    assert_eq!(reused.parts.len(), 1);
    let mut fresh = BrowserWorker::new().unwrap();
    fresh.qualify().await.unwrap();
    let mut fresh = Some(fresh);
    let mut control = Vec::new();
    run_model_with_worker(SourceBundle::new(CASCADE.to_vec()),
        &ModelOptions { ids: Some([104].into_iter().collect()), ..Default::default() },
        &mut fresh, || panic!("control has a qualified Worker"), |o, _| control.push(o)).await.unwrap();
    let ProductOutcome::Published(control) = control.pop().unwrap() else { panic!("fresh control") };
    assert_eq!(reused.parts[0].positions, control.parts[0].positions);
    assert_eq!(reused.parts[0].indices, control.parts[0].indices);
    assert_eq!(reused.parts[0].world_from_object, control.parts[0].world_from_object);
    web_sys::console::log_1(&"sdk witness executed: retained refusal browser lifecycle".into());
}

#[wasm_bindgen_test(async)]
async fn retained_browser_consumed_hosts_preserve_settled_worker() {
    let text = std::str::from_utf8(CASCADE).unwrap().replace("#24,#333", "#24,#26");
    let mut native = BrowserWorker::new().unwrap();
    native.qualify().await.unwrap();
    let incarnation = native.incarnation();
    let mut worker = Some(native);
    let mut rows = Vec::new();
    let summary = run_model_with_worker(SourceBundle::new(text.into_bytes()),
        &ModelOptions { ids: Some((100..105).collect()), max_restarts: 0, ..Default::default() },
        &mut worker, || panic!("settled empty-result refusal must not replace the Worker"),
        |o, _| rows.push(o)).await.unwrap();
    assert_eq!((summary.candidates, summary.published, summary.restarts), (5,1,0));
    assert_eq!(summary.by_code.get("empty_result"), Some(&4));
    assert!(matches!(rows.last(), Some(ProductOutcome::Published(s)) if s.product_id == 104));
    let worker = worker.as_ref().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    assert_eq!(JsFuture::from(worker.owner.driver.live_object_count()).await.unwrap().as_f64(), Some(0.));
    web_sys::console::log_1(&"sdk witness executed: retained consumed-host browser lifecycle".into());
}
