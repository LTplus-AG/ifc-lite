// SPDX-License-Identifier: MPL-2.0
//! #7955 M11-A: the real module Worker resolves the same appearance, bit for bit, as the native run.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;

#[wasm_bindgen(inline_js = r#"
export async function m11aReference() {
  const response = await fetch('/smlib/m11-a-native-appearance.json');
  if (!response.ok) throw new Error('M11-A native reference missing: ' + response.status);
  return response.json();
}
const bits = value => { const f = new Float32Array(1); f[0] = value; return new Uint32Array(f.buffer)[0]; };
export function m11aObserve(outcome) {
  if (outcome.status !== 'published') return { id: outcome.expressId, code: outcome.code };
  if (outcome.obligationsUnmet.includes('IfcAppearance')) throw new Error(outcome.expressId + ': IfcAppearance still unmet');
  return { id: outcome.expressId, code: 'published', parts: outcome.parts.map(part => ({
    rgbaBits: part.color.map(bits), materialName: part.materialName ?? null, geometryItemId: part.geometryItemId ?? null })) };
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11aReference)]
    async fn reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m11aObserve)]
    fn observe(outcome: &JsValue) -> Result<JsValue, JsValue>;
}
#[derive(serde::Deserialize, PartialEq, Debug)]
struct Part {
    #[serde(rename = "rgbaBits")]
    rgba_bits: [u32; 4],
    #[serde(rename = "materialName")]
    material_name: Option<String>,
    #[serde(rename = "geometryItemId")]
    geometry_item_id: Option<u32>,
}
#[derive(serde::Deserialize)]
struct Row { id: u32, code: String, parts: Option<Vec<Part>> }
#[derive(serde::Deserialize)]
struct Model { path: String, rows: Vec<Row> }

#[wasm_bindgen_test(async)]
async fn retained_browser_m11_a_appearance_parity() {
    let native: Vec<Model> = serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    assert!(!native.is_empty());
    for model in native {
        let bytes: &[u8] = match model.path.as_str() {
            "tests/fixtures/synthetic-retained/f-m11a-appearance.ifc" =>
                include_bytes!("../../../../tests/fixtures/synthetic-retained/f-m11a-appearance.ifc"),
            "tests/fixtures/synthetic-retained/f-i-presentation.ifc" =>
                include_bytes!("../../../../tests/fixtures/synthetic-retained/f-i-presentation.ifc"),
            "apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc" =>
                include_bytes!("../../../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc"),
            other => panic!("unstaged model {other}"),
        };
        let ids = model.rows.iter().map(|row| row.id).collect();
        let mut run = crate::api::IfcAPI::new().retained_model(bytes, Some(ids)).await.unwrap();
        for expected in model.rows {
            let actual: Row = serde_wasm_bindgen::from_value(observe(&run.next_outcome()).unwrap()).unwrap();
            assert_eq!((actual.id, actual.code.as_str()), (expected.id, expected.code.as_str()), "{}", model.path);
            assert_eq!(actual.parts, expected.parts, "{} #{}: browser appearance differs from native", model.path, expected.id);
        }
        assert!(run.next_outcome().is_undefined());
    }
}
