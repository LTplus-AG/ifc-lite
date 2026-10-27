// SPDX-License-Identifier: MPL-2.0
//! E1 parity scaffold: actual module Worker against an independently supplied
//! native unit-rectangle receipt. Whole-model fixture/code parity is added in
//! E2 when D's model API is available. Never synthesize the native reference.
use super::*;

#[wasm_bindgen(inline_js = "export async function m1NativeReference() {\n\
  const engine = await fetch('/smlib/ifclite_smlib_browser.wasm');\n\
  if (!engine.ok) return null;\n\
  const reference = await fetch('/smlib/m1-native-unit-rectangle.json');\n\
  if (!reference.ok) return null;\n\
  return await reference.json();\n\
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m1NativeReference)]
    async fn native_reference() -> Result<JsValue, JsValue>;
}

#[derive(serde::Deserialize)]
struct NativeReference {
    fixture: String,
    volume: f64,
}

#[wasm_bindgen_test(async)]
async fn retained_browser_m1_native_wasm_receipt_parity_scaffold() {
    let value = match native_reference().await {
        Ok(value) if !value.is_null() => value,
        Ok(value) => {
            web_sys::console::log_1(&JsValue::from_str(&format!(
                "SKIP M1 native/wasm parity: real SMLib wasm engine or D native reference absent ({value:?}); SKIP is not parity evidence"
            )));
            return;
        }
        Err(error) => panic!("M1 native parity reference could not be read: {error:?}"),
    };
    let native: NativeReference = serde_wasm_bindgen::from_value(value).unwrap();
    assert_eq!(native.fixture, "unit-rectangle-1m");
    assert!(native.volume.is_finite() && native.volume > 0.);
    let mut worker = BrowserWorker::new().unwrap();
    let result = worker
        .evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET)
        .await
        .unwrap();
    assert!((volume(&result) - native.volume).abs() / native.volume <= 1e-9);
    // This scaffold does not claim the whole-model refusal-code parity that
    // requires D's whole-model driver and E2's binding.
}
