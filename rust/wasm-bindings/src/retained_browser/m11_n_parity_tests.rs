// SPDX-License-Identifier: MPL-2.0
//! #7955: every corpus corner traverses the actual browser Worker boundary.
use super::*;
#[wasm_bindgen(inline_js = "
export async function m11NormalsReference() {
  const response = await fetch('/smlib/m11-n-native.json');
  if (!response.ok) throw new Error('M11-N real native reference missing');
  return response.json();
}
export function m11VerifyNormals(actual, expected, model) {
  const fail = message => { throw new Error(model + ':' + expected.id + ': ' + message); };
  if (!actual || actual.expressId !== expected.id || actual.status !== expected.status) fail('outcome parity');
  if (actual.status === 'refused') { if (actual.code !== expected.code) fail('refusal parity'); return 0; }
  if (actual.obligationsUnmet.includes('SurfaceNormals')) fail('SurfaceNormals not discharged');
  if (actual.parts.length !== expected.parts.length) fail('part cardinality');
  const compare = (a,b,tolerance,label) => {
    if (!a || a.length !== b.length) fail(label + ' cardinality');
    for (let i=0;i<a.length;i++) if (!Number.isFinite(a[i]) || Math.abs(a[i]-b[i]) > tolerance*Math.max(1,Math.abs(b[i]))) fail(label+'['+i+']');
  };
  actual.parts.forEach((part,i) => {
    const source = expected.parts[i];
    compare(part.indices,source.indices,0,'triangles');
    compare(part.positions,source.positions,1e-12,'positions');
    compare(part.worldFromObject,source.frame,1e-12,'frame');
    compare(part.normals,source.normals,1e-12,'normal digest');
  });
  return 1;
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11NormalsReference)]
    async fn reference() -> Result<JsValue,JsValue>;
    #[wasm_bindgen(catch, js_name = m11VerifyNormals)]
    fn verify(actual: &JsValue, expected: &JsValue, model: &str) -> Result<u32,JsValue>;
}

#[wasm_bindgen_test(async)]
async fn retained_browser_m11_n_normals_corpus_parity() {
    let models = js_sys::Array::from(&reference().await.unwrap());
    assert!(models.length() > 0);
    let mut published = 0;
    for model in models.iter() {
        let name = js_sys::Reflect::get(&model,&"model".into()).unwrap().as_string().unwrap();
        let source = js_sys::Reflect::get(&model,&"source".into()).unwrap().as_string().unwrap();
        let rows = js_sys::Array::from(&js_sys::Reflect::get(&model,&"rows".into()).unwrap());
        assert!(rows.length() > 0);
        let mut run = crate::api::IfcAPI::new().retained_model(source.as_bytes(),None).await.unwrap();
        for row in rows.iter() { published += verify(&run.next_outcome(),&row,&name).unwrap(); }
        assert!(run.next_outcome().is_undefined(),"unexpected product in {name}");
    }
    assert!(published >= 131,"all committed published rows must execute");
}
