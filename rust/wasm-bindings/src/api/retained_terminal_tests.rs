// SPDX-License-Identifier: MPL-2.0
//! #7955 actual Worker through public bind/admit/execute/take API.
use super::*;
use super::super::IfcAPI;
use wasm_bindgen_test::*;
// #2019 host [0,4] x [0,.2] x [0,3], cutter [-1,5] x [-.2,.4] x [-1,4].
fn source() -> String {
    include_str!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc")
        .replace("((1.5,0.1))","((2.,0.1))").replace("#42,1.,0.4)","#42,6.,0.6)")
        .replace("((0.,0.,0.3))","((0.,0.,-1.))").replace("#43,#45,#4,1.2)","#43,#45,#4,5.)")
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j2_terminal_actual_worker_production_api() {
    let api = IfcAPI::new();
    let source = source();
    let model = api.bind_retained_model(source.into_bytes()).unwrap();
    let mut product = model.admit_product(30).unwrap();
    let mut executor = RetainedBrowserExecutor {worker:crate::retained_browser::BrowserWorker::new().unwrap()};
    executor.worker.qualify_dependencies().await.unwrap();
    let summary = product.execute(&mut executor,0.00001,15.,64<<20).await.expect("J2_TERMINAL_API");
    assert_eq!(js_sys::Reflect::get(&summary,&JsValue::from_str("final_product_available")).unwrap(),JsValue::TRUE);
    let result = product.take_removed_product().expect("J2_TERMINAL_API");
    assert_eq!(result.product_id(),30);
    assert_eq!(result.outcome(),"authenticated_whole_product_removal");
    assert!(product.take_removed_product().is_err(),"J2_TERMINAL_API_REPLAY");
    assert!(product.execute(&mut executor,0.00001,15.,64<<20).await.is_err());
    executor.worker.retire();
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j2_terminal_actual_worker_source_obligation_refuses() {
    let api = IfcAPI::new();
    let source = source().replace("ENDSEC;\nEND-ISO-10303-21;",
        "#900=IFCMATERIALLAYER($,-1.,$,$,$,$,$);\nENDSEC;END-ISO-10303-21;");
    let model = api.bind_retained_model(source.into_bytes()).unwrap();
    let mut product = model.admit_product(30).unwrap();
    let mut executor = RetainedBrowserExecutor {worker:crate::retained_browser::BrowserWorker::new().unwrap()};
    executor.worker.qualify_dependencies().await.unwrap();
    let error = product.execute(&mut executor,0.00001,15.,64<<20).await.unwrap_err();
    assert_eq!(js_sys::Reflect::get(&error,&JsValue::from_str("code")).unwrap(),JsValue::from_str("unsupported"),"J2_TERMINAL_API_SOURCE");
    assert!(product.take_removed_product().is_err());
    executor.worker.retire();
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j2_terminal_stale_and_retired_api() {
    for stale in [false,true] {
        let api = IfcAPI::new();
        let model = api.bind_retained_model(source().into_bytes()).unwrap();
        let mut product = model.admit_product(30).unwrap();
        let mut executor = RetainedBrowserExecutor {worker:crate::retained_browser::BrowserWorker::new().unwrap()};
        executor.worker.qualify_dependencies().await.unwrap();
        if stale { model.invalidate_source(); } else { executor.worker.retire(); }
        assert!(product.execute(&mut executor,0.00001,15.,64<<20).await.is_err(),"J2_TERMINAL_API_STALE");
        assert!(product.take_removed_product().is_err());
        executor.worker.retire();
    }
}
