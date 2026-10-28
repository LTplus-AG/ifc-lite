// SPDX-License-Identifier: MPL-2.0
//! #7955: every corpus corner traverses the actual browser Worker boundary.
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
#[wasm_bindgen(inline_js = "
let m11DiagnosticCount = 0;
let m11ReorderedParts = 0;
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
  const mismatches = [];
  const compare = (a,b,tolerance,label) => {
    if (!a || a.length !== b.length) { mismatches.push(label + ' cardinality'); return; }
    for (let i=0;i<a.length;i++) if (!Number.isFinite(a[i]) || Math.abs(a[i]-b[i]) > tolerance*Math.max(1,Math.abs(b[i]))) {
      mismatches.push(label+'['+i+']: actual='+a[i]+' expected='+b[i]); return;
    }
  };
  const equivalent = (a,b) => a.length === b.length && a.every((v,i) =>
    Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v-b[i]) <= 1e-12*Math.max(1,Math.abs(b[i])));
  // SDK tessellation may reorder vertices/triangles and flip a planar diagonal.
  // Compare the normal field at each geometric vertex, including every split
  // direction in both directions. Triangle multiplicity is not a field value.
  const field = part => {
    const vertices = Array.from({length:part.positions.length/3},(_,i) => ({
      p:Array.from(part.positions.slice(3*i,3*i+3)), normals:[]
    }));
    if (part.normals.length !== part.indices.length*3) throw new Error('normal cardinality');
    for (let t=0;t<part.indices.length;t+=3) {
      const points = Array.from(part.indices.slice(t,t+3),v=>vertices[v].p);
      const edge = i => Array.from({length:3},(_,j)=>points[i][j]-points[0][j]);
      const world = p => Array.from({length:3},(_,i)=>part.frame[i]*p[0]+part.frame[i+4]*p[1]+part.frame[i+8]*p[2]);
      const a=world(edge(1)),b=world(edge(2));
      const facet=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      for (let c=0;c<3;c++) {
        const n=Array.from(part.normals.slice(3*(t+c),3*(t+c+1)));
        const cosine=n.reduce((sum,v,i)=>sum+v*facet[i],0)/(Math.hypot(...n)*Math.hypot(...facet));
        if (!Number.isFinite(cosine) || cosine < Math.cos(Math.PI/18)) throw new Error('normal outside own-facet crease cone');
        vertices[part.indices[t+c]].normals.push(n);
      }
    }
    return vertices;
  };
  const covers = (a,b,label) => {
    for (const vertex of a) {
      const peers=b.filter(candidate=>equivalent(vertex.p,candidate.p));
      if (!peers.length) { mismatches.push(label+' vertex '+JSON.stringify(vertex.p)); return; }
      const normals=peers.flatMap(p=>p.normals);
      for (const n of vertex.normals) if (!normals.some(other=>equivalent(n,other))) {
        mismatches.push(label+' normal at '+JSON.stringify(vertex.p)+': '+JSON.stringify(n)); return;
      }
    }
  };
  actual.parts.forEach((part,i) => {
    const source = expected.parts[i];
    compare(part.worldFromObject,source.frame,1e-12,'frame');
    if (part.indices.length !== source.indices.length || part.positions.length !== source.positions.length)
      mismatches.push('mesh cardinality');
    if (!equivalent(Array.from(part.indices),source.indices) || !equivalent(Array.from(part.positions),source.positions))
      m11ReorderedParts++;
    try {
      const browser=field({...part,frame:part.worldFromObject});
      const native=field(source);
      covers(browser,native,'browser/native'); covers(native,browser,'native/browser');
    } catch (error) { mismatches.push(error.message); }
  });
  if (mismatches.length) {
    if (m11DiagnosticCount++ < 2) console.log('M11_N_PARITY_REPRO '+JSON.stringify({model,expected,
      actual:actual.parts.map(p=>({positions:Array.from(p.positions),indices:Array.from(p.indices),
        frame:Array.from(p.worldFromObject),normals:Array.from(p.normals)}))}));
    fail(mismatches.join('; '));
  }
  console.log('M11-N normal field parity '+model+':'+expected.id+'; reordered parts so far '+m11ReorderedParts);
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
            match verify(&run.next_outcome(),&row,&name) {
                Ok(count) => published += count,
                Err(error) => errors.push(String::from(js_sys::Error::from(error).message())),
            }
        }
        assert!(run.next_outcome().is_undefined(),"unexpected product in {name}");
    }
    println!("M11-N browser compared {compared} outcomes; {published} published comparisons passed");
    assert!(errors.is_empty(), "{} browser parity violations:\n{}", errors.len(), errors.join("\n"));
    assert!(published >= 131,"all committed published rows must execute");
}
