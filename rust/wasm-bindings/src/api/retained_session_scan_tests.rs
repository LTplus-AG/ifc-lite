// SPDX-License-Identifier: MPL-2.0
//! #8415: the actual streaming session joins finishes without a whole-file rescan.
//! The inert Worker supplies protocol geometry, never SDK/parity evidence.
use super::*;
use crate::retained_browser::model::test_driver::TestDriver;
use ifc_lite_processing::parity_test_support::take_finish_rescans;
use std::{cell::Cell, rc::Rc};
use wasm_bindgen_test::*;

#[wasm_bindgen(module = "/js/retained-model-tests.mjs")]
extern "C" {
    #[wasm_bindgen(catch, js_name = driverFactory)]
    async fn driver_factory() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = preparePeer)]
    async fn prepare_peer(fail_at: u32) -> Result<JsValue, JsValue>;
}

#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_session_finish_scan() -> Result<(), JsValue> {
    let _driver = TestDriver::install(driver_factory().await?);
    prepare_peer(0).await?;
    let bytes = include_bytes!("../../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc");
    take_finish_rescans();
    drop(ModelFinishes::from_content(bytes));
    assert_eq!(take_finish_rescans(), 1, "control: the whole-file constructor is counted");
    let meshes_seen = Rc::new(Cell::new(0));
    let seen = meshes_seen.clone();
    let callback = Closure::<dyn FnMut(JsValue)>::new(move |value: JsValue| {
        let meshes = Reflect::get(&value, &"meshes".into()).unwrap();
        if !meshes.is_undefined() {
            seen.set(seen.get() + Reflect::get(&meshes, &"length".into()).unwrap().as_f64().unwrap() as usize);
            Reflect::get(&meshes, &"free".into()).unwrap().unchecked_into::<js_sys::Function>()
                .call0(&meshes).unwrap();
        }
    });
    let options = Object::new();
    Reflect::set(&options, &"detail".into(), &"view".into())?;
    let mut session = RetainedModelSession::new();
    session.run(bytes.to_vec(), options.unchecked_into(), callback.as_ref().unchecked_ref()).await?;
    assert!(meshes_seen.get() > 0, "the real session reached its view-mesh finish join");
    assert_eq!(take_finish_rescans(), 0, "the session must reuse the candidate scan and source index");
    console_log!("retained session scan witness: published meshes, zero finish rescans");
    Ok(())
}
