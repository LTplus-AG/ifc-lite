// SPDX-License-Identifier: MPL-2.0
//! #7955: actual model API and module Worker; hand oracle plus native parity.
#![cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);
#[wasm_bindgen(inline_js = "export async function m5Reference() { const r=await fetch('/smlib/m5-native-clips.json'); if(!r.ok) throw new Error('M5 native reference missing'); return r.json(); }
export async function m5LineageReference() { const r=await fetch('/smlib/m5-native-lineage.json'); if(!r.ok) throw new Error('M5 native lineage reference missing'); return r.json(); }
export function m5Measure(outcome) {
  if(outcome.status==='refused')return {id:outcome.expressId,code:outcome.code,volume:null};
  let volume=0,triangles=0,vertices=0;
  for(const part of outcome.parts){
    const p=part.positions,t=part.indices;triangles+=t.length/3;vertices+=p.length/3;
    const point=i=>[0,1,2].map(k=>p[i*3+k]-p[k]);let six=0;
    for(let i=0;i<t.length;i+=3){const [a,b,c]=[point(t[i]),point(t[i+1]),point(t[i+2])];
      six+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);}
    volume+=Math.abs(six/6);
  }
  return {id:outcome.expressId,code:'published',volume,triangles,vertices};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name=m5Reference)]
    async fn reference()->Result<JsValue,JsValue>;
    #[wasm_bindgen(catch, js_name=m5LineageReference)]
    async fn lineage_reference()->Result<JsValue,JsValue>;
    #[wasm_bindgen(catch, js_name=m5Measure)]
    fn measure(outcome:&JsValue)->Result<JsValue,JsValue>;
}
#[derive(serde::Deserialize)]
struct Row {id:u32,code:String,volume:Option<f64>,#[serde(default)] curved:bool,triangles:Option<u64>,vertices:Option<u64>}
#[derive(serde::Deserialize)]
struct NativeReference {synthetic:Vec<Row>,adversarial:Row}
#[derive(serde::Deserialize)]
struct Expectations {synthetic:Vec<Row>,#[serde(rename="issue5314")] issue:Vec<Row>}
#[wasm_bindgen_test(async)]
async fn retained_browser_m5_clips_hand_oracle_and_native_parity(){
    let expected:Expectations=serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/expected.d/m5.json")).unwrap();
    let native:NativeReference=serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    assert_eq!(native.synthetic.len(),expected.synthetic.len());
    let mut mismatches=Vec::new();
    for (bytes,rows,parity) in [
        (include_bytes!("../../../../tests/fixtures/synthetic-retained/f-e-clips.ifc").as_slice(),expected.synthetic,Some(native.synthetic)),
        (include_bytes!("../../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc").as_slice(),expected.issue,None),
    ]{
        let mut run=crate::api::IfcAPI::new().retained_model(bytes,Some(rows.iter().map(|r|r.id).collect())).await.unwrap();
        for (i,expected) in rows.iter().enumerate(){
            let actual:Row=serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
            assert_eq!((actual.id,actual.code.as_str()),(expected.id,expected.code.as_str()));
            match(actual.volume,expected.volume){
                (Some(a),Some(b))=>assert!((a-b).abs()/b.abs()<=if expected.curved{2e-3}else{1e-6},"#{} {a} vs {b}",actual.id),
                (None,None)=>{},_=>panic!("oracle volume presence differs"),
            }
            if let Some(native)=&parity{
                assert_eq!((actual.id,actual.code.as_str()),(native[i].id,native[i].code.as_str()));
                if let (Some(a),Some(b))=(actual.volume,native[i].volume){
                    if (a-b).abs()/b.abs()>1e-9 {
                        mismatches.push(format!("native parity #{}: browser {a} ({:?} tri, {:?} vert) vs native {b} ({:?} tri, {:?} vert), relative {:e}",
                            actual.id,actual.triangles,actual.vertices,native[i].triangles,native[i].vertices,(a-b).abs()/b.abs()));
                    }
                }
            }
        }
        assert!(run.next_outcome().is_undefined());
    }
    assert!(mismatches.is_empty(),"{}",mismatches.join("; "));
    let bytes=include_bytes!("../../../../tests/fixtures/synthetic-retained/m5-adversarial-nonschema-mapped-operand.ifc");
    let mut extension=crate::api::IfcAPI::new().retained_model(bytes,Some(vec![27])).await.unwrap();
    let actual:Row=serde_wasm_bindgen::from_value(measure(&extension.next_outcome()).unwrap()).unwrap();
    assert_eq!((actual.id,actual.code.as_str()),(27,"published"));
    assert_eq!(actual.code,native.adversarial.code);
    let (a,b)=(actual.volume.unwrap(),native.adversarial.volume.unwrap());
    assert!((a-b).abs()/b.abs()<=1e-9,"non-schema extension native parity");
    assert!(extension.next_outcome().is_undefined());
    console_log!("sdk witness executed: m5_browser_parity");
}

#[path = "../../../../tests/fixtures/synthetic-retained/m5_chain_source.rs"]
mod chains;
#[wasm_bindgen_test(async)]
async fn retained_browser_m5_lineage_boundary_matches_native(){
    let reference:serde_json::Value=serde_wasm_bindgen::from_value(lineage_reference().await.unwrap()).unwrap();
    for expected in reference.as_array().unwrap(){
        let count=expected["count"].as_u64().unwrap() as usize;
        let text=chains::chain(count);
        let mut run=crate::api::IfcAPI::new().retained_model(text.as_bytes(),Some(vec![22,145])).await.unwrap();
        let outcome=run.next_outcome();
        let actual:Row=serde_wasm_bindgen::from_value(measure(&outcome).unwrap()).unwrap();
        assert_eq!(actual.id,22);assert_eq!(actual.code,expected["code"].as_str().unwrap());
        if count==129 {
            assert_eq!(actual.code,"resource_exhausted");
            assert!(js_sys::Reflect::get(&outcome,&JsValue::from_str("parts")).unwrap().is_undefined(),"no partial publication");
        }else{assert_eq!(actual.code,"published");}
        let next:Row=serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
        assert_eq!((next.id,next.code.as_str()),(145,"published"));
        assert!(run.next_outcome().is_undefined());
    }
    console_log!("sdk witness executed: m5_browser_lineage");
}
#[wasm_bindgen_test(async)]
async fn retained_browser_m5_clipped_opening_hand_oracle(){
    let text=include_str!("../../../../tests/fixtures/synthetic-retained/f-e-clips.ifc")
        .replace("'SweptSolid',(#115)","'CSG',(#505)")
        .replace("ENDSEC;\nEND-ISO","#500=IFCCARTESIANPOINT((0.,0.,1.));#501=IFCAXIS2PLACEMENT3D(#500,$,$);#502=IFCPLANE(#501);#503=IFCHALFSPACESOLID(#502,.T.);#505=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#115,#503);ENDSEC;\nEND-ISO");
    let mut run=crate::api::IfcAPI::new().retained_model(text.as_bytes(),Some(vec![200])).await.unwrap();
    let actual:Row=serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
    assert_eq!((actual.id,actual.code.as_str()),(200,"published"));
    assert!((actual.volume.unwrap()-35.).abs()/35.<1e-6);
    assert!(run.next_outcome().is_undefined());
    console_log!("sdk witness executed: m5_browser_clipped_opening");
}
