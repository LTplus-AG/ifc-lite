// SPDX-License-Identifier: MPL-2.0
//! #7955: actual model API and module Worker; hand oracle plus native parity.
#![cfg(target_arch = "wasm32")]
use super::*;
#[wasm_bindgen(inline_js = "export async function m5Reference() { const r=await fetch('/smlib/m5-native-clips.json'); if(!r.ok) throw new Error('M5 native reference missing'); return r.json(); }
export function m5Measure(outcome) {
  if(outcome.status==='refused')return {id:outcome.expressId,code:outcome.code,volume:null};
  let volume=0;
  for(const part of outcome.parts){
    const p=part.positions,t=part.indices,point=i=>[0,1,2].map(k=>p[i*3+k]-p[k]);let six=0;
    for(let i=0;i<t.length;i+=3){const [a,b,c]=[point(t[i]),point(t[i+1]),point(t[i+2])];
      six+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);}
    volume+=Math.abs(six/6);
  }
  return {id:outcome.expressId,code:'published',volume};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name=m5Reference)]
    async fn reference()->Result<JsValue,JsValue>;
    #[wasm_bindgen(catch, js_name=m5Measure)]
    fn measure(outcome:&JsValue)->Result<JsValue,JsValue>;
}
#[derive(serde::Deserialize)]
struct Row {id:u32,code:String,volume:Option<f64>}
#[derive(serde::Deserialize)]
struct Expectations {synthetic:Vec<Row>,#[serde(rename="issue5314")] issue:Vec<Row>}
#[wasm_bindgen_test(async)]
async fn retained_browser_m5_clips_hand_oracle_and_native_parity(){
    let expected:Expectations=serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/expected.d/m5.json")).unwrap();
    let native:Vec<Row>=serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    assert_eq!(native.len(),expected.synthetic.len());
    for (bytes,rows,parity) in [
        (include_bytes!("../../../../tests/fixtures/synthetic-retained/f-e-clips.ifc").as_slice(),expected.synthetic,Some(native)),
        (include_bytes!("../../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc").as_slice(),expected.issue,None),
    ]{
        let mut run=crate::api::IfcAPI::new().retained_model(bytes,Some(rows.iter().map(|r|r.id).collect())).await.unwrap();
        for (i,expected) in rows.iter().enumerate(){
            let actual:Row=serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
            assert_eq!((actual.id,actual.code.as_str()),(expected.id,expected.code.as_str()));
            match(actual.volume,expected.volume){
                (Some(a),Some(b))=>assert!((a-b).abs()/b.abs()<=if expected.id==105{2e-3}else{1e-6},"#{} {a} vs {b}",actual.id),
                (None,None)=>{},_=>panic!("oracle volume presence differs"),
            }
            if let Some(native)=&parity{
                assert_eq!((actual.id,actual.code.as_str()),(native[i].id,native[i].code.as_str()));
                if let (Some(a),Some(b))=(actual.volume,native[i].volume){assert!((a-b).abs()/b.abs()<=1e-9,"native parity #{} {a} vs {b}",actual.id);}
            }
        }
        assert!(run.next_outcome().is_undefined());
    }
    console_log!("sdk witness executed: m5_browser_parity");
}
