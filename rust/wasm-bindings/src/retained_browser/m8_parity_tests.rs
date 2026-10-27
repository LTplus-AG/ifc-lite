// SPDX-License-Identifier: MPL-2.0
//! #3641 actual module Worker compared with a separately executed native run.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
#[wasm_bindgen(inline_js = "export async function m8Reference() {
  const r = await fetch('/smlib/m8-native.json');
  if (!r.ok) return null;
  return await r.json();
}
export function m8Summary(value) {
  if (value.status === 'refused') return {id:value.expressId,code:value.code,volume:null};
  let volume=0;
  for (const part of value.parts) {
    const p=part.positions, ix=part.indices;
    let v=0;
    const at=i=>[p[3*i]-p[0],p[3*i+1]-p[1],p[3*i+2]-p[2]];
    for(let i=0;i<ix.length;i+=3) {
      const a=at(ix[i]),b=at(ix[i+1]),c=at(ix[i+2]);
      v+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    }
    volume+=Math.abs(v);
  }
  return {id:value.expressId,code:'published',volume};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name=m8Reference)]
    async fn reference() -> Result<JsValue,JsValue>;
    #[wasm_bindgen(js_name=m8Summary)]
    fn summary(value: &JsValue) -> JsValue;
}
#[derive(serde::Deserialize, Debug)]
struct Row { id: u32, code: String, volume: Option<f64> }
#[wasm_bindgen_test(async)]
async fn retained_browser_m8_real_worker_matches_native_codes_and_volumes() {
    let native = reference().await.unwrap();
    if native.is_null() {
        web_sys::console::log_1(&"SKIP M8 browser parity: staged m8-native.json absent; not parity evidence".into());
        return;
    }
    let native: Vec<Row> = serde_wasm_bindgen::from_value(native).unwrap();
    assert_eq!(native.len(),4);
    let api = crate::api::IfcAPI::new();
    let mut run = api.retained_model(include_bytes!("../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc"),None).await.unwrap();
    for expected in native {
        let value = run.next_outcome();
        assert!(!value.is_undefined());
        let actual: Row = serde_wasm_bindgen::from_value(summary(&value)).unwrap();
        assert_eq!((actual.id,&actual.code),(expected.id,&expected.code));
        match (actual.volume,expected.volume) {
            (Some(a),Some(b)) => assert!((a-b).abs()/b.abs() <= 1e-9,"{a} vs {b}"),
            (None,None) => {},
            other => panic!("parity volume mismatch: {other:?}"),
        }
    }
    assert!(run.next_outcome().is_undefined());
    web_sys::console::log_1(&"sdk witness executed: m8 real browser Worker parity".into());
}
