// SPDX-License-Identifier: MPL-2.0
//! #7955 M9: exercise the public streaming API from its owning module.
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_test::*;
const MIXED: &[u8] = include_bytes!("../../../geometry/tests/fixtures/issue_6446_mapped_source_frames.ifc");
#[wasm_bindgen_test(async)]
async fn retained_browser_m9_session_announces_and_publishes_orphan_type() {
    use std::{cell::RefCell, rc::Rc};
    let events = Rc::new(RefCell::new(Vec::new()));
    let captured = events.clone();
    let callback = Closure::<dyn FnMut(JsValue)>::new(move |value| captured.borrow_mut().push(value));
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"detail".into(), &"shape".into()).unwrap();
    js_sys::Reflect::set(&options, &"ids".into(), &js_sys::Uint32Array::from([105u32].as_slice())).unwrap();
    let mut session = super::RetainedModelSession::new();
    session.run(MIXED.to_vec(), options.unchecked_into(), callback.as_ref().unchecked_ref()).await.unwrap();
    let events = events.borrow();
    assert_eq!(events.len(), 2);
    assert_eq!(js_sys::Reflect::get(&events[0], &"kind".into()).unwrap().as_string().as_deref(), Some("start"));
    let ids = js_sys::Uint32Array::new(&js_sys::Reflect::get(&events[0], &"candidateIds".into()).unwrap()).to_vec();
    assert_eq!(ids, [105]);
    assert_eq!(js_sys::Reflect::get(&events[1], &"kind".into()).unwrap().as_string().as_deref(), Some("published"));
    let actual = crate::retained_browser::m9_parity_tests::measure(&events[1]).unwrap();
    assert_eq!(js_sys::Reflect::get(&actual, &"id".into()).unwrap().as_f64(), Some(105.));
    assert!((js_sys::Reflect::get(&actual, &"volume".into()).unwrap().as_f64().unwrap()-6.).abs() <= 1e-9);
}
