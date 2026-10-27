// SPDX-License-Identifier: MPL-2.0
//! Actual WASM whole-model entry over E1's inert peer, never SDK geometry evidence.
use super::*;
use crate::retained_browser::model::test_driver::TestDriver;
use wasm_bindgen_test::*;

#[wasm_bindgen(module = "/js/retained-model-tests.mjs")]
extern "C" {
    #[wasm_bindgen(catch, js_name = driverFactory)]
    async fn driver_factory() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = assertMissingModuleReported)]
    async fn assert_missing_module_reported() -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = preparePeer)]
    async fn prepare_peer(fail_at: u32) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = assertPublished)]
    fn assert_published(value: &JsValue, id: u32) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = assertRefused)]
    fn assert_refused(value: &JsValue, id: u32, code: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = assertPeers)]
    async fn assert_peers(start: &JsValue, count: u32) -> Result<(), JsValue>;
}
const BOX: &str = include_str!("../../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc");
fn append(extra: &str) -> String {
    BOX.replace("ENDSEC;\nEND-ISO", &format!("{extra}\nENDSEC;\nEND-ISO"))
}

// Refs #7955 E2: file ordering, typed refusal, skip empty/type jobs and reuse.
#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_model_publishes_and_refuses_in_canonical_order() {
    let _driver = TestDriver::install(driver_factory().await.unwrap());
    let start = prepare_peer(0).await.unwrap();
    let source = append(
        "#80=IFCBUILDINGELEMENTPROXY('p',$,$,$,$,#24,#26,$,.NOTDEFINED.);\n\
#81=IFCMATERIALLAYER($,0.1,$);#85=IFCMATERIALLAYER($,0.2,$);#82=IFCMATERIALLAYERSET((#81,#85),'layers');\n\
#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.);\n\
#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#80),#83);\n\
#60=IFCBUILDINGELEMENTPROXY('p2',$,$,$,$,#24,#26,$,.NOTDEFINED.);\n\
#90=IFCBOILERTYPE('t',$,$,$,$,$,(#91),$,$,.NOTDEFINED.);\n\
#91=IFCREPRESENTATIONMAP(#2,#25);\n\
#95=IFCBUILDINGELEMENTPROXY('empty',$,$,$,$,#24,$,$,.NOTDEFINED.);",
    );
    let api = IfcAPI::new();
    let mut run = api.retained_model(source.as_bytes(), None).await.unwrap();
    assert_published(&run.next_outcome(), 27).unwrap();
    assert_refused(&run.next_outcome(), 80, "material_layer_strategy").unwrap();
    assert_published(&run.next_outcome(), 60).unwrap();
    assert!(run.next_outcome().is_undefined());
    assert!(run.next_outcome().is_undefined());
    assert_peers(&start, 1).await.unwrap();

    let start = prepare_peer(0).await.unwrap();
    let mut run = api
        .retained_model(source.as_bytes(), Some(vec![]))
        .await
        .unwrap();
    assert!(run.next_outcome().is_undefined());
    assert_peers(&start, 0).await.unwrap();
    let mut run = api
        .retained_model(source.as_bytes(), Some(vec![80]))
        .await
        .unwrap();
    assert_refused(&run.next_outcome(), 80, "material_layer_strategy").unwrap();
    assert!(run.next_outcome().is_undefined());
    assert_peers(&start, 0).await.unwrap();
}

// #7955 E2: after one accepted part, a second-part runtime failure exposes no
// mesh for that product. The next product gets a new, independently qualified peer.
#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_model_atomicity_and_worker_replacement() {
    let _driver = TestDriver::install(driver_factory().await.unwrap());
    let start = prepare_peer(3).await.unwrap();
    let source = append(
        "#105=IFCEXTRUDEDAREASOLID(#18,#2,#3,4.);\n\
#102=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#19,#105));\n\
#103=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));\n\
#100=IFCBUILDINGELEMENTPROXY('parts',$,$,$,$,#24,#103,$,.NOTDEFINED.);\n\
#110=IFCBUILDINGELEMENTPROXY('after',$,$,$,$,#24,#26,$,.NOTDEFINED.);",
    );
    let mut run = IfcAPI::new()
        .retained_model(source.as_bytes(), None)
        .await
        .unwrap();
    assert_published(&run.next_outcome(), 27).unwrap();
    assert_refused(&run.next_outcome(), 100, "kernel_failure").unwrap();
    assert_published(&run.next_outcome(), 110).unwrap();
    assert!(run.next_outcome().is_undefined());
    assert_peers(&start, 2).await.unwrap();
}

// #8188: a bad fixture URL must reject inside a running test, not prevent the
// entire harness from loading. The JS deadline is below the runner's 120s cap.
#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_model_missing_module_reports_failure() {
    assert_missing_module_reported().await.unwrap();
}
