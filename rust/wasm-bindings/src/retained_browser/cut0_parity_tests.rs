// SPDX-License-Identifier: MPL-2.0
//! The same derived prism recipes through an actual browser module Worker.
use super::BrowserWorker;
use ifc_lite_geometry::document::GeometryDocument;
use wasm_bindgen_test::*;
#[path = "../../../geometry/tests/support/cut0_prisms.rs"]
mod fixture;
wasm_bindgen_test_configure!(run_in_browser);
#[wasm_bindgen_test(async)]
async fn retained_browser_cut0_prism_box_and_arc_construction() {
    let mut worker=BrowserWorker::new().unwrap(); worker.qualify().await.unwrap();
    for arc in [false,true] {
        let mut document=GeometryDocument::new();
        let definition=document.add_retained_prism(fixture::prism(arc)).unwrap();
        let request=document.prepare_retained(definition,worker.incarnation()).unwrap();
        let result=worker.evaluate_retained(request,0.00001,1.,16<<20).await.unwrap();
        fixture::verify(&result.completion().tessellation,arc);
        console_log!("sdk witness executed: {}",if arc { "cut0_prism_arc" } else { "cut0_prism_box" });
    }
}
