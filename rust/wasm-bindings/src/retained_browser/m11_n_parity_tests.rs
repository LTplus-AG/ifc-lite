// SPDX-License-Identifier: MPL-2.0
//! #7955: every corpus corner traverses the actual browser Worker boundary.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
// The expectation is independently derived from source IFC by the native
// source walker, then applied afresh to every actual browser corner. It never
// uses native output normals as the source-normal oracle.
#[allow(dead_code)]
#[path = "../../../retained-native/src/oracle/math.rs"]
mod math;
#[allow(dead_code)]
#[path = "../../../retained-native/src/oracle/normals_check.rs"]
mod source_oracle;
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OraclePart {
    positions: Vec<f64>, indices: Vec<u32>, world_from_object: [f64;16], normals: Vec<f64>,
}
#[wasm_bindgen(inline_js = "
export async function m11NormalsReference() {
  const response = await fetch('/smlib/m11-n-native.json');
  if (!response.ok) throw new Error('M11-N real native reference missing');
  return response.json();
}
export function m11OracleParts(actual) {
  return actual.parts.map(p=>({positions:Array.from(p.positions),indices:Array.from(p.indices),
    worldFromObject:Array.from(p.worldFromObject),normals:Array.from(p.normals)}));
}
const totals={identicalMeshes:0,differentMeshes:0,browserMatchedVertices:0,nativeMatchedVertices:0,
  browserUnmatchedVertices:0,nativeUnmatchedVertices:0,browserMatchedCorners:0,nativeMatchedCorners:0,
  browserUnmatchedCorners:0,nativeUnmatchedCorners:0};
const same=(a,b)=>a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
const digest=values=>{
  const data=new DataView(new ArrayBuffer(8));let hash=0xcbf29ce484222325n;
  for(const value of values){data.setFloat64(0,value,true);
    for(let i=0;i<8;i++)hash=BigInt.asUintN(64,(hash^BigInt(data.getUint8(i)))*0x100000001b3n);}
  return hash.toString(16);
};
const angle=(a,b)=>Math.atan2(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]),
  a.reduce((sum,v,i)=>sum+v*b[i],0));
const field=(part,kinds)=>{
  const vertices=Array.from({length:part.positions.length/3},(_,i)=>({p:Array.from(part.positions.slice(3*i,3*i+3)),corners:[]}));
  for(let i=0;i<part.indices.length;i++)vertices[part.indices[i]].corners.push({
    n:Array.from(part.normals.slice(3*i,3*i+3)),surface:kinds[Math.floor(i/3)]??null});
  return vertices.filter(v=>v.corners.length);
};
// #7955 ruling B: absolute 1e-9 metre mesh-local position matching, independent
// of enumeration and triangulation. Search neighbouring bins at their borders.
const covers=(a,b,source,label,counts,tolerances,fail)=>{
  const bins=new Map(),key=p=>p.map(v=>Math.round(v/1e-9));
  for(const v of b){const k=key(v.p).join(',');if(!bins.has(k))bins.set(k,[]);bins.get(k).push(v);}
  for(const v of a){
    const k=key(v.p),peers=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)
      for(const q of bins.get([k[0]+x,k[1]+y,k[2]+z].join(','))??[])
        if(Math.hypot(...q.p.map((p,i)=>p-v.p[i]))<=1e-9)peers.push(q);
    if(!peers.length){counts[label+'UnmatchedVertices']++;counts[label+'UnmatchedCorners']+=v.corners.length;continue;}
    counts[label+'MatchedVertices']++;counts[label+'MatchedCorners']+=v.corners.length;
    const candidates=peers.flatMap(q=>q.corners);
    for(const corner of v.corners){
      const curved=corner.surface!==null && !Object.hasOwn(source[corner.surface],'Plane');
      const limit=curved?tolerances.normalCurvedRadians:tolerances.normalPlanarRadians;
      if(!candidates.some(other=>other.surface===corner.surface && angle(corner.n,other.n)<=limit))
        fail(label+' matched-corner normal at '+JSON.stringify(v.p)+'; source surface '+corner.surface);
    }
  }
};
export function m11VerifyNormals(actual,expected,model,kinds,tolerances) {
  const fail=message=>{throw new Error(model+':'+expected.id+': '+message);};
  if(!actual || actual.expressId!==expected.id || actual.status!==expected.status)fail('outcome parity');
  if(actual.status==='refused'){if(actual.code!==expected.code)fail('refusal parity');return 0;}
  if(actual.obligationsUnmet.includes('SurfaceNormals'))fail('SurfaceNormals not discharged');
  if(actual.parts.length!==expected.parts.length)fail('part cardinality');
  const counts=Object.fromEntries(Object.keys(totals).map(k=>[k,0]));
  actual.parts.forEach((part,i)=>{
    const reference=expected.parts[i];
    if(!part.worldFromObject.every((v,j)=>Math.abs(v-reference.frame[j])<=1e-12*Math.max(1,Math.abs(reference.frame[j]))))fail('frame parity');
    if(same(part.positions,reference.positions)&&same(part.indices,reference.indices)&&same(part.worldFromObject,reference.frame)){
      counts.identicalMeshes++;
      if(digest(part.normals)!==digest(reference.normals))fail('normal digest on byte-identical mesh');
    }else counts.differentMeshes++;
    const browser=field(part,kinds[i]),native=field(reference,reference.surfaceIndices);
    covers(browser,native,expected.sourceSurfaces,'browser',counts,tolerances,fail);
    covers(native,browser,expected.sourceSurfaces,'native',counts,tolerances,fail);
  });
  for(const k of Object.keys(totals))totals[k]+=counts[k];
  console.log('M11_N_PARITY '+JSON.stringify({model,id:expected.id,...counts}));
  return 1;
}
export function m11ParityTotals(){console.log('M11_N_PARITY_TOTALS '+JSON.stringify(totals));}
")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11NormalsReference)]
    async fn reference() -> Result<JsValue,JsValue>;
    #[wasm_bindgen(catch, js_name = m11VerifyNormals)]
    fn verify(actual: &JsValue, expected: &JsValue, model: &str, kinds: &JsValue, tolerances: &JsValue) -> Result<u32,JsValue>;
    #[wasm_bindgen(js_name = m11OracleParts)]
    fn oracle_parts(actual: &JsValue) -> JsValue;
    #[wasm_bindgen(js_name = m11ParityTotals)]
    fn totals();
}

fn source_gate(actual: &JsValue, row: &JsValue, name: &str, tolerances: &serde_json::Value)
    -> Result<JsValue,String> {
    if js_sys::Reflect::get(row,&"status".into()).unwrap().as_string().as_deref() != Some("published") {
        return Ok(JsValue::NULL);
    }
    let source: Vec<source_oracle::Surface> = serde_wasm_bindgen::from_value(
        js_sys::Reflect::get(row,&"sourceSurfaces".into()).unwrap()).map_err(|e|e.to_string())?;
    let parts: Vec<OraclePart> = serde_wasm_bindgen::from_value(oracle_parts(actual)).map_err(|e|e.to_string())?;
    let id = js_sys::Reflect::get(row,&"id".into()).unwrap().as_f64().unwrap();
    let mut kinds = Vec::new();
    for (i,part) in parts.iter().enumerate() {
        let check = source_oracle::check_mesh(&part.positions,&part.indices,&part.world_from_object,&part.normals,&source)?;
        if check.unattributed != 0 || check.planar_radians > tolerances["normalPlanarRadians"].as_f64().unwrap()
            || check.curved_radians > tolerances["normalCurvedRadians"].as_f64().unwrap()
            || check.unit_error > tolerances["normalUnitAbsolute"].as_f64().unwrap() {
            return Err(format!("browser source normal gate {name}:#{id} part {i}: {check:?}"));
        }
        println!("M11-N browser source gate {name}:#{id} part {i}: {} corners, planar {}, curved {}, unit {}",
            check.corners,check.planar_radians,check.curved_radians,check.unit_error);
        kinds.push(check.surface_indices);
    }
    serde_wasm_bindgen::to_value(&kinds).map_err(|e|e.to_string())
}

#[wasm_bindgen_test(async)]
async fn retained_browser_m11_n_normals_corpus_parity() {
    let tolerances: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/cli-retained/tolerances.d/m11-n.json")).unwrap();
    let js_tolerances = js_sys::JSON::parse(&tolerances.to_string()).unwrap();
    let models = js_sys::Array::from(&reference().await.unwrap());
    assert!(models.length() > 0);
    let mut published = 0;
    let mut compared = 0;
    let mut errors = Vec::new();
    for model in models.iter() {
        let name = js_sys::Reflect::get(&model,&"model".into()).unwrap().as_string().unwrap();
        let source = js_sys::Reflect::get(&model,&"source".into()).unwrap().as_string().unwrap();
        let rows = js_sys::Array::from(&js_sys::Reflect::get(&model,&"rows".into()).unwrap());
        assert!(rows.length() > 0);
        let ids = js_sys::Reflect::get(&model,&"ids".into()).unwrap();
        let ids = (!ids.is_null() && !ids.is_undefined()).then(||
            js_sys::Array::from(&ids).iter().map(|id| id.as_f64().unwrap() as u32).collect());
        let mut run = crate::api::IfcAPI::new().retained_model(source.as_bytes(),ids).await.unwrap();
        for row in rows.iter() {
            compared += 1;
            let actual = run.next_outcome();
            let kinds = match source_gate(&actual,&row,&name,&tolerances) {
                Ok(kinds) => kinds,
                Err(error) => {errors.push(error);continue;}
            };
            match verify(&actual,&row,&name,&kinds,&js_tolerances) {
                Ok(count) => published += count,
                Err(error) => errors.push(String::from(js_sys::Error::from(error).message())),
            }
        }
        assert!(run.next_outcome().is_undefined(),"unexpected product in {name}");
    }
    totals();
    println!("M11-N browser compared {compared} outcomes; {published} published comparisons passed");
    assert!(errors.is_empty(), "{} browser parity violations:\n{}", errors.len(), errors.join("\n"));
    assert!(published >= 131,"all committed published rows must execute");
}
