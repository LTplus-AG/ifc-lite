// SPDX-License-Identifier: MPL-2.0
//! #7955: real model API and module Worker against staged native observations.
use super::*;
#[wasm_bindgen(inline_js = "export async function m3Reference() { const r = await fetch('/smlib/m3-native-openings.json'); if (!r.ok) throw new Error('M3 native reference missing'); return r.json(); }
export function m3Measure(outcome) {
  if (outcome.status === 'refused') return {id:outcome.expressId,code:outcome.code,volume:null};
  let volume = 0;
  for (const part of outcome.parts) {
    if (part.layer) { volume += part.cappedVolumeM3; continue; }
    const p = part.positions, t = part.indices;
    let six = 0;
    const point = i => [0,1,2].map(k => p[i*3+k] - p[k]);
    for (let i=0;i<t.length;i+=3) {
      const [a,b,c] = [point(t[i]),point(t[i+1]),point(t[i+2])];
      six += a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0]);
    }
    volume += Math.abs(six/6);
  }
  return {id:outcome.expressId,code:'published',volume};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m3Reference)]
    async fn reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m3Measure)]
    fn measure(outcome: &JsValue) -> Result<JsValue, JsValue>;
}
#[derive(serde::Deserialize)]
struct Row { id: u32, code: String, volume: Option<f64> }
#[derive(serde::Deserialize)]
struct Reference { #[serde(rename = "issue2019")] issue: Vec<Row>, synthetic: Vec<Row>, nonbakeable: Vec<Row> }
#[wasm_bindgen_test(async)]
async fn retained_browser_m3_opening_parity() {
    let native: Reference = serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    let nonbakeable = include_str!("../../../../tests/fixtures/synthetic-retained/f-d-openings.ifc")
        .replace("OPERATOR3D($,$,#1,2.,$)", "OPERATOR3DNONUNIFORM($,$,#1,1.E200,$,1.E200,1.)");
    for (bytes, rows) in [
        (include_bytes!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc").as_slice(), native.issue),
        (include_bytes!("../../../../tests/fixtures/synthetic-retained/f-d-openings.ifc").as_slice(), native.synthetic),
        (nonbakeable.as_bytes(), native.nonbakeable),
    ] {
        let mut run = crate::api::IfcAPI::new().retained_model(bytes, Some(rows.iter().map(|r| r.id).collect())).await.unwrap();
        for expected in rows {
            let actual: Row = serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
            assert_eq!((actual.id, actual.code.as_str()), (expected.id, expected.code.as_str()));
            match (actual.volume, expected.volume) {
                (Some(a), Some(b)) => assert!((a-b).abs() / b.abs() <= 1e-9, "#{} {a} vs {b}", actual.id),
                (None, None) => {},
                _ => panic!("volume presence differs"),
            }
        }
        assert!(run.next_outcome().is_undefined());
    }
}
