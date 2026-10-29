// SPDX-License-Identifier: MPL-2.0
//! #7955 M10: whole-model API over the real module Worker, no kernel mocks.
#![cfg(target_arch = "wasm32")]
use crate::api::IfcAPI;
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

#[wasm_bindgen(inline_js = r#"
export async function m10NativeReference() {
  const response = await fetch('/m10-native-reference.output.json');
  if (!response.ok) throw new Error('M10 requires a staged real native reference: ' + response.status);
  const rows = await response.json();
  for (const [fixture,count] of [['main',22],['adversarial',1],['scaled',5],['submm',4]]) {
    if (rows.filter(r => (r.fixture ?? 'main') === fixture).length !== count)
      throw new Error('M10 incomplete native reference for ' + fixture);
  }
  return rows;
}
export function m10AssertOutcome(value, rows, tolerance, fixture) {
  const row = rows.find(row => row.expressId === value.expressId && (row.fixture ?? 'main') === fixture);
  if (!row || row.seen) throw new Error('Unexpected/duplicate product ' + value.expressId);
  row.seen = true;
  const code = value.status === 'published' ? 'published' : value.code;
  if (row.code !== code) throw new Error(`${value.expressId}: native ${row.code}, browser ${code}`);
  if (code !== 'published') {
    if (code === 'kernel_failure' && row.kernelStatus !== value.kernelStatus)
      throw new Error(`${value.expressId}: kernel status ${row.kernelStatus} != ${value.kernelStatus}`);
    return;
  }
  let volume = 0;
  for (const part of value.parts) {
    const p = part.positions, m = part.worldFromObject, ids = part.indices;
    // Integrate in object coordinates; remove translation first so the georef
    // case tests placement rather than cancellation of survey-sized numbers.
    const point = id => [p[3*id]-p[0], p[3*id+1]-p[1], p[3*id+2]-p[2]];
    let signed = 0;
    for (let i=0;i<ids.length;i+=3) {
      const a=point(ids[i]), b=point(ids[i+1]), c=point(ids[i+2]);
      signed += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    }
    const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
    if (!(signed*det > 0)) throw new Error(`Inward affine part ${value.expressId}`);
    volume += signed*det;
  }
  if (!Number.isFinite(volume) || Math.abs(volume-row.volume)/row.volume > tolerance)
    throw new Error(`${value.expressId}: native volume ${row.volume}, browser ${volume}`);
}
export function m10AssertComplete(rows) {
  if (rows.some(row => !row.seen)) throw new Error('M10 omitted a native candidate');
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = m10NativeReference)]
    async fn native_reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m10AssertOutcome)]
    fn assert_outcome(value: &JsValue, rows: &JsValue, tolerance: f64, fixture: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = m10AssertComplete)]
    fn assert_complete(rows: &JsValue) -> Result<(), JsValue>;
}

#[wasm_bindgen_test(async)]
async fn retained_browser_m10_native_module_worker_parity() {
    let native = native_reference().await.unwrap();
    let tolerance: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/cli-retained/tolerances.json"
    ))
    .unwrap();
    let relative = tolerance["nativeWasmVolumeRelative"].as_f64().unwrap();
    let mut run = IfcAPI::new()
        .retained_model(
            include_bytes!("../../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc"),
            None,
        )
        .await
        .unwrap();
    loop {
        let value = run.next_outcome();
        if value.is_undefined() {
            break;
        }
        assert_outcome(&value, &native, relative, "main").unwrap();
    }
    // Separate controller-extension parity; these non-schema products are not
    // in the coverage universe and are not evidence of IFC qualification.
    let mut adversarial = IfcAPI::new()
        .retained_model(
            include_bytes!(
                "../../../../tests/fixtures/synthetic-retained/f-h-affine-finals-adversarial.ifc"
            ),
            None,
        )
        .await
        .unwrap();
    loop {
        let value = adversarial.next_outcome();
        if value.is_undefined() {
            break;
        }
        assert_outcome(&value, &native, relative, "adversarial").unwrap();
    }
    for (fixture,bytes) in [
        ("scaled",include_bytes!("../../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc").as_slice()),
        ("submm",include_bytes!("../../../geometry/tests/fixtures/issue_1985_metre_submm_scale.ifc").as_slice()),
    ] {
        let mut run=IfcAPI::new().retained_model(bytes,None).await.unwrap();
        loop {
            let value=run.next_outcome();
            if value.is_undefined() {break}
            assert_outcome(&value,&native,relative,fixture).unwrap();
        }
    }
    assert_complete(&native).unwrap();
}
