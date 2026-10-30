// SPDX-License-Identifier: MPL-2.0
//! #7955 M6: whole-model API through the actual browser module Worker.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);
#[wasm_bindgen(inline_js = "export function m6Measure(o) {
  if (o.status === 'refused') return { id:o.expressId, code:o.code, volume:null };
  let volume=0;
  for (const part of o.parts) {
    const p=part.positions, t=part.indices;
    const point=i=>[0,1,2].map(k=>p[3*i+k]-p[k]); let six=0;
    for (let i=0;i<t.length;i+=3) {
      const [a,b,c]=[point(t[i]),point(t[i+1]),point(t[i+2])];
      six+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    }
    volume+=Math.abs(six/6);
  }
  return {id:o.expressId,code:'published',volume};
}
export async function m6NativeReference() {
  const r=await fetch('/smlib/m6-native.json');if(!r.ok)throw new Error('M6 native reference missing');return r.json();
}")]
extern "C" {
    #[wasm_bindgen(catch,js_name=m6Measure)]
    fn measure(value:&JsValue)->Result<JsValue,JsValue>;
    #[wasm_bindgen(catch,js_name=m6NativeReference)]
    async fn native_reference()->Result<JsValue,JsValue>;
}
#[derive(serde::Deserialize,Debug)]
struct Row {id:u32,code:String,volume:Option<f64>}
const SOURCE:&[u8]=include_bytes!("../../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
async fn rows(ids:Vec<u32>)->Vec<Row> {
    let mut run=crate::api::IfcAPI::new().retained_model(SOURCE,Some(ids)).await.unwrap();
    let mut rows=Vec::new();loop {let value=run.next_outcome();if value.is_undefined(){break;}
        rows.push(serde_wasm_bindgen::from_value(measure(&value).unwrap()).unwrap());
    } rows
}
fn expected()->Vec<Row> {
    #[derive(serde::Deserialize)]struct Pins{rows:Vec<Row>}
    let pins:Pins=serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/expected.d/m6-halfspaces.json")).unwrap();pins.rows
}
#[wasm_bindgen_test(async)]
async fn retained_browser_m6_bounded_hand_oracle() {
    let wanted=expected().into_iter().filter(|r|![1004,1007,1008,1009,1011].contains(&r.id)).collect::<Vec<_>>();
    let actual=rows(wanted.iter().map(|r|r.id).collect()).await;
    assert_eq!(actual.len(),wanted.len());
    for (a,e) in actual.iter().zip(&wanted) {
        assert_eq!((a.id,a.code.as_str()),(e.id,e.code.as_str()));
        match (a.volume,e.volume) {
            (Some(a),Some(v))=>{let tol:serde_json::Value=serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/tolerances.d/m6.json")).unwrap();
                let key=if e.id==1005{"curved"}else{"linear"};let limit=tol["boundedSectionVolumeRelative"][key].as_f64().unwrap();assert!((a-v).abs()<=limit*v.abs());},
            (None,None)=>{},_=>panic!("volume presence differs"),
        }
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_m6_native_parity() {
    let native:Vec<Row>=serde_wasm_bindgen::from_value(native_reference().await.unwrap()).unwrap();
    let actual=rows(native.iter().map(|r|r.id).collect()).await;
    assert_eq!(actual.len(),native.len());
    for (a,b) in actual.iter().zip(native) {
        assert_eq!((a.id,a.code.as_str()),(b.id,b.code.as_str()));
        match (a.volume,b.volume) {
            (Some(a),Some(b))=>assert!((a-b).abs()<=1e-9*b.abs()),
            (None,None)=>{},_=>panic!("native/browser volume presence differs"),
        }
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_m6_boxed_twin_outcomes() {
    let actual=rows(vec![1007,1008,1009]).await;assert_eq!(actual.len(),3);
    for boxed in [&actual[0],&actual[2]] {
        assert_eq!(boxed.code,actual[1].code);
        assert_eq!(boxed.volume.map(f64::to_bits),actual[1].volume.map(f64::to_bits));
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_m6_publication() {
    let ids=vec![1004,1007,1008,1009,1011];let actual=rows(ids.clone()).await;
    assert_eq!(actual.iter().map(|r|r.id).collect::<Vec<_>>(),ids);
    for a in actual {
        let e=expected().into_iter().find(|r|r.id==a.id).unwrap();assert_eq!(a.code,e.code);
        if let Some(volume)=e.volume {assert!((a.volume.unwrap()-volume).abs()<=1e-6*volume);}
    }
}
