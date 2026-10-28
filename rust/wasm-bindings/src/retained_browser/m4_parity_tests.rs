// SPDX-License-Identifier: MPL-2.0
//! #7955: actual module Worker, layered tags, and native band volume parity.
use super::*;
#[wasm_bindgen(inline_js="export async function m4Reference() { const r=await fetch('/smlib/m3-native-openings.json'); if(!r.ok) throw new Error('M4 staged native reference missing'); return r.json(); }
export function m4Measure(p) {
 if(p.status!=='published') return {id:p.expressId,code:p.code,bands:[]};
 if(p.obligationsUnmet.includes('MaterialLayers')) throw new Error('Layer obligation remains');
 const edges=new Map();
 for(const part of p.parts) {
   const key=i=>Array.from(part.positions.subarray(i*3,i*3+3)).map(x=>Object.is(x,-0)?0:x).join(',');
   for(let i=0;i<part.indices.length;i+=3) {
     const t=Array.from(part.indices.subarray(i,i+3),key);
     for(let j=0;j<3;j++) { const a=t[j],b=t[(j+1)%3],k=a<b?`${a};${b}`:`${b};${a}`; edges.set(k,(edges.get(k)??0)+1); }
   }
 }
 if([...edges.values()].some(n=>n!==2)) throw new Error('M4 union has closure defects');
 return {id:p.expressId,code:p.status,bands:p.parts.map(part=>({index:part.layer?.index,materialId:part.layer?.materialId,volume:part.cappedVolumeM3}))};
}")]
extern "C" {
    #[wasm_bindgen(catch,js_name=m4Reference)] async fn reference()->Result<JsValue,JsValue>;
    #[wasm_bindgen(catch,js_name=m4Measure)] fn measure(p:&JsValue)->Result<JsValue,JsValue>;
}
#[derive(serde::Deserialize)]
struct Band { index:u16, #[serde(rename="materialId")] material_id:u32, volume:f64 }
#[derive(serde::Deserialize)]
struct Row { id:u32,code:String,bands:Vec<Band> }
#[derive(serde::Deserialize)]
struct Reference { m4straight:Vec<Row>,m4curved:Vec<Row>,m4synthetic:Vec<Row> }
#[wasm_bindgen_test(async)]
async fn retained_browser_m4_layers_native_parity() {
    let native:Reference=serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    for (bytes,rows) in [
        (include_bytes!("../../../../tests/fixtures/cli-retained/layered-wall.ifc").as_slice(),native.m4straight),
        (include_bytes!("../../../../tests/fixtures/synthetic-retained/f-a-curved.ifc").as_slice(),native.m4curved),
        (include_bytes!("../../../../tests/fixtures/synthetic-retained/f-g-layers.ifc").as_slice(),native.m4synthetic),
    ] {
        assert!(!rows.is_empty());
        let mut run=crate::api::IfcAPI::new().retained_model(bytes,Some(rows.iter().map(|r|r.id).collect())).await.unwrap();
        for expected in rows {
            let actual:Row=serde_wasm_bindgen::from_value(measure(&run.next_outcome()).unwrap()).unwrap();
            let code=match expected.id {8027=>"material_layer_strategy",9027=>"layer_caps_unresolved",_=>"published"};
            assert_eq!(expected.code,code,"native must qualify the witness");
            assert_eq!((actual.id,actual.code),(expected.id,expected.code));
            assert_eq!(actual.bands.len(),expected.bands.len());
            for (a,b) in actual.bands.iter().zip(expected.bands) {
                assert_eq!((a.index,a.material_id),(b.index,b.material_id));
                assert!((a.volume-b.volume).abs()/b.volume.abs()<=1e-9,"#{} band{}: {} vs {}",actual.id,a.index,a.volume,b.volume);
            }
        }
        assert!(run.next_outcome().is_undefined());
    }
}
