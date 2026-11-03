// SPDX-License-Identifier: MPL-2.0
//! #8291: the real module Worker publishes the same palette, UV bits and face keys as the native run.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

#[wasm_bindgen(inline_js = r#"
export async function m11tReference() {
  const response = await fetch('/smlib/m11-t-native-surface.json');
  if (!response.ok) throw new Error('M11-T native reference missing: ' + response.status);
  return response.json();
}
export function m11tObserve(outcome) {
  if (outcome.status !== 'published') throw new Error(outcome.expressId + ' refused ' + outcome.code);
  const bits = values => { const view = new BigUint64Array(values.buffer, values.byteOffset, values.length);
    return Array.from(view, value => value.toString()); };
  return { id: outcome.expressId, parts: outcome.parts.map(part => ({
    palette: part.palette ? Array.from(part.palette.triangles) : null,
    uvBits: part.texture ? bits(part.texture.uvs) : null,
    faces: part.faces.table })) };
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11tReference)]
    async fn reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m11tObserve)]
    fn observe(outcome: &JsValue) -> Result<JsValue, JsValue>;
}
#[derive(serde::Deserialize, PartialEq, Debug)]
struct Part {
    palette: Option<Vec<u32>>,
    #[serde(rename = "uvBits")]
    uv_bits: Option<Vec<String>>,
    faces: Vec<String>,
}
#[derive(serde::Deserialize)]
struct Row { id: u32, parts: Vec<Part> }

#[wasm_bindgen_test(async)]
async fn retained_browser_m11_t_surface_parity() {
    let native: Vec<Row> = serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    assert_eq!(native.len(), 4);
    let bytes = include_bytes!("../../../../tests/fixtures/synthetic-retained/f-t-face-set-presentation.ifc");
    let mut ids: Vec<u32> = native.iter().map(|row| row.id).collect();
    ids.sort_unstable();
    let mut run = crate::api::IfcAPI::new().retained_model(bytes, Some(ids.clone())).await.unwrap();
    for id in ids {
        let actual: Row = serde_wasm_bindgen::from_value(observe(&run.next_outcome()).unwrap()).unwrap();
        assert_eq!(actual.id, id);
        let expected = native.iter().find(|row| row.id == id).unwrap();
        assert_eq!(actual.parts, expected.parts, "#{id}: browser surface differs from native");
    }
    assert!(run.next_outcome().is_undefined());
}
