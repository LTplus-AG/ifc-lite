// Pure strict comparator; no package, model or producer imports.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateWasmCapture,validateNativeCapture,nativeWire,hash} from './schema.mjs';
import {exact} from './exact-wire.mjs';
const canonical=v=>JSON.stringify(v);
const escape=k=>String(k).replaceAll('~','~0').replaceAll('/','~1');
const missing=Symbol('missing');
const absent=()=>({missing:true});
function differences(a,b,path=''){
 const av=a===missing?absent():a,bv=b===missing?absent():b;
 if(canonical(av)===canonical(bv))return [];
 // Exact typed wires are the only permitted atomic compound values.
 if(av?.typedArray||bv?.typedArray)return [{path,left:av,right:bv}];
 const ao=a!==missing&&a!==null&&typeof a==='object',bo=b!==missing&&b!==null&&typeof b==='object';
 if((ao&&bo&&Array.isArray(a)===Array.isArray(b))||(a===missing&&bo)||(b===missing&&ao)){
  const keys=[...new Set([...Object.keys(ao?a:{}),...Object.keys(bo?b:{})])];
  if(keys.length===0)return [{path,left:av,right:bv}];
  return keys.flatMap(k=>differences(ao&&Object.hasOwn(a,k)?a[k]:missing,bo&&Object.hasOwn(b,k)?b[k]:missing,path+'/'+escape(k)));
 }
 return [{path,left:av,right:bv}];
}
export function strictCompare(left,right,rules,context){
 const used=new Set(),expected=[],unknown=[];
 for(const d of differences(left,right)){
  const matches=rules.filter(r=>r.state==='BOUND_EXACT_VALUES'&&r.fixtureSha256===context.fixtureSha256&&r.source===context.source&&r.arm===context.arm&&r.path===d.path);
  assert.ok(matches.length<=1,'overlapping EXPECTED_DIFF');const r=matches[0];
  if(!r){unknown.push(d);continue;}
  assert.ok(r.id&&r.authority&&r.condition&&r.removeWhen,'named authority/condition/removal required');
  assert.ok(!/[\*]/.test(r.path),'wildcard EXPECTED_DIFF forbidden');
  for(const v of [d.left,d.right])assert.ok(v===null||typeof v!=='object'||v.typedArray||v.missing===true||Object.keys(v).length===0,'whole object/array EXPECTED_DIFF forbidden');
  assert.equal(hash(d.left),r.leftSha256,'unexpected left value: '+r.id);assert.equal(hash(d.right),r.rightSha256,'unexpected right value: '+r.id);
  used.add(r.id);expected.push({...d,rule:r.id});
 }
 const required=rules.filter(r=>r.state==='BOUND_EXACT_VALUES'&&r.fixtureSha256===context.fixtureSha256&&r.source===context.source&&r.arm===context.arm);
 const stale=required.filter(r=>!used.has(r.id)).map(r=>r.id);
 return {result:unknown.length?'INCOMPLETE_UNKNOWN_DIFF':stale.length?'INCOMPLETE_STALE_EXPECTED_DIFF':'MATCH_OR_EXACT_EXPECTED_DIFF',expected,unknown,stale};
}
function nativeView(r){return {jobs:r.observations.filter(e=>e.event==='native_jobs'),elements:r.observations.filter(e=>['element_job','effective-element-color','element-result','representation-gate','fallback-mesh'].includes(e.event)),meshes:r.raw.meshes.map(m=>({id:m.id,ifcType:m.ifcType.toUpperCase(),geometryClass:m.geometryClass,geometryItemId:m.geometryItemId,materialId:m.materialId,positions:nativeWire(m.positions),normals:nativeWire(m.normals),indices:nativeWire(m.indices),color:nativeWire(m.color),origin:nativeWire(m.origin),uvs:m.uvs?nativeWire(m.uvs):null,localBounds:m.localBounds?nativeWire(m.localBounds):null,localToWorld:m.localToWorld?nativeWire(m.localToWorld):null,texture:m.texture})),frame:{rtc:r.raw.rtcOffset,world:r.raw.frameToWorld,coordinateSpace:r.raw.coordinateSpace},schema:r.raw.metadata.schema_version,geometryEntityCount:r.raw.metadata.geometry_entity_count,refusals:{input:r.raw.refusals.input,prepass:r.raw.refusals.prepass},diagnostics:r.raw.stats.geometry_diagnostics??null,allNativeRaw:r.raw,allNativeObservations:r.observations};}
export function wasmView(r){const once=r.provenance.consumer==='once',meta=once?r.raw.oncePublicReturn:r.raw.meta;return {jobs:r.raw.jobs,elements:r.observations.geometry,meshes:r.raw.meshes.map(m=>{const g=m.getters;return {id:g.expressId,ifcType:g.ifcType.toUpperCase(),geometryClass:g.geometryClass,geometryItemId:g.geometryItemId,materialId:g.materialId,positions:g.positions,normals:g.normals,indices:g.indices,color:g.color,origin:g.origin,uvs:g.uvs,localBounds:g.localBounds,localToWorld:g.localToWorld,texture:{rgba:g.textureRgba,id:g.textureId,url:g.textureUrl,width:g.textureWidth,height:g.textureHeight,repeatS:g.textureRepeatS,repeatT:g.textureRepeatT}};}),frame:{meta},schema:{unavailable:'public prepass exposes no schema string'},geometryEntityCount:once?r.raw.oncePublicReturn.totalJobs:r.raw.complete.totalJobs,refusals:{unavailable:'PipelineDiagnostics schema1 lacks native refused input/prepass counters',unit:meta.unitRefused,scan:r.raw.scan},diagnostics:r.raw.batches.map(b=>b.collection.getters.diagnostics),allPublicRaw:r.raw,allPublicObservations:r.observations};}
const commonSettings=({prepassEntry,...settings})=>settings;
export function compareReceipts(n,w,policy){
 validateNativeCapture(n);validateWasmCapture(w);
 assert.equal(n.contract.id,w.contract.id,'same named fixture work contract');
 assert.ok(n.observationEnabled&&w.provenance.observation.enabled,'same invocation observations mandatory');
 assert.equal(n.source,w.provenance.source.commit,'never compare native61 with WASMb437');assert.equal(n.input.sha256,w.provenance.fixtureSha256);
 // Raw target-specific payload remains in views: no timer/cache/metadata drop,
 // no mesh sort/weld/rounding/world-coordinate inference. This deliberately
 // reports currently unbound target differences rather than claiming parity.
 const nv=nativeView(n),wv=wasmView(w);
 const report=strictCompare(nv,wv,policy.entries,{fixtureSha256:n.input.sha256,source:n.source,arm:'native-vs-'+w.provenance.consumer});
 return {...report,orderedPayloadWitnesses:{native:nv.meshes.map(hash),publicWasm:wv.meshes.map(hash),nativeReceiptSha256:hash(n),publicReceiptSha256:hash(w)},scope:'Pure full-payload hashes preserve output order and existing target basis. They are not a spatial equivalence oracle.'};
}
export function compareObservationPair(plain,observed,policy,kind){
 assert.ok(['native','wasm'].includes(kind),'explicit known observation pair kind');
 assert.deepEqual(plain.contract,observed.contract,'observation cannot weaken work contract');
 if(kind==='native'){validateNativeCapture(plain);validateNativeCapture(observed);assert.equal(plain.observationEnabled,false);assert.equal(observed.observationEnabled,true);assert.equal(plain.source,observed.source);assert.deepEqual(plain.input,observed.input);assert.deepEqual(plain.mode,observed.mode);}
 else{validateWasmCapture(plain);validateWasmCapture(observed);assert.equal(plain.provenance.observation.enabled,false);assert.equal(observed.provenance.observation.enabled,true);assert.equal(plain.provenance.source.commit,observed.provenance.source.commit);assert.equal(plain.provenance.fixtureSha256,observed.provenance.fixtureSha256);assert.equal(plain.provenance.consumer,observed.provenance.consumer);assert.deepEqual(plain.provenance.settings,observed.provenance.settings);}
 return strictCompare(plain.raw,observed.raw,policy.entries,{fixtureSha256:kind==='native'?plain.input.sha256:plain.provenance.fixtureSha256,source:kind==='native'?plain.source:plain.provenance.source.commit,arm:'observation-noninterference-'+kind});
}
export function comparePublicRoutes(serial,columns,policy){
 validateWasmCapture(serial);validateWasmCapture(columns);
 assert.equal(serial.provenance.consumer,'serial');assert.equal(columns.provenance.consumer,'columns');
 assert.equal(serial.provenance.source.commit,columns.provenance.source.commit);assert.equal(serial.provenance.fixtureSha256,columns.provenance.fixtureSha256);
 assert.deepEqual(serial.contract,columns.contract);
 assert.equal(serial.provenance.settings.prepassEntry,'buildPrePassStreaming');assert.equal(columns.provenance.settings.prepassEntry,'buildPrePassStreamingSharded');
 assert.deepEqual(commonSettings(serial.provenance.settings),commonSettings(columns.provenance.settings));
 assert.equal(serial.provenance.mode,columns.provenance.mode);assert.equal(serial.provenance.observation.enabled,columns.provenance.observation.enabled);
 return strictCompare(serial.raw,columns.raw,policy.entries,{fixtureSha256:serial.provenance.fixtureSha256,source:serial.provenance.source.commit,arm:'public-serial-vs-columns'});
}
export function compareOncePublicRoute(once,other,policy){
 validateWasmCapture(once);validateWasmCapture(other);
 assert.equal(once.provenance.consumer,'once','left route must be the direct combined once API');
 assert.ok(['serial','columns'].includes(other.provenance.consumer),'right route must be an existing streaming/direct-columns public route');
 assert.equal(once.provenance.source.commit,other.provenance.source.commit);assert.equal(once.provenance.fixtureSha256,other.provenance.fixtureSha256);
 assert.equal(once.provenance.mode,other.provenance.mode);assert.equal(once.provenance.observation.enabled,other.provenance.observation.enabled);
 assert.deepEqual(once.contract,other.contract);
 assert.equal(once.provenance.settings.prepassEntry,'buildPrePassOnce');
 assert.equal(other.provenance.settings.prepassEntry,other.provenance.consumer==='serial'?'buildPrePassStreaming':'buildPrePassStreamingSharded');
 assert.deepEqual(commonSettings(once.provenance.settings),commonSettings(other.provenance.settings));
 // Compare complete raw receipts without deleting the route-specific public
 // structures. Differences remain unknown until separately witnessed/bound.
 return strictCompare(once.raw,other.raw,policy.entries,{fixtureSha256:once.provenance.fixtureSha256,source:once.provenance.source.commit,arm:'public-once-vs-'+other.provenance.consumer});
}
export function compareRevisions(base,final,policy){
 const isNative=base.schema==='c4-0-native-v1';
 if(isNative){validateNativeCapture(base);validateNativeCapture(final);assert.deepEqual(base.mode,final.mode);assert.equal(base.observationEnabled,false);assert.equal(final.observationEnabled,false);}
 else{validateWasmCapture(base);validateWasmCapture(final);assert.equal(base.provenance.consumer,final.provenance.consumer);assert.equal(base.provenance.mode,final.provenance.mode);assert.deepEqual(base.provenance.settings,final.provenance.settings);assert.equal(base.provenance.observation.enabled,false);assert.equal(final.provenance.observation.enabled,false);}
 assert.deepEqual(base.contract,final.contract);
 const bs=isNative?base.source:base.provenance.source.commit,fs=isNative?final.source:final.provenance.source.commit;
 assert.equal(bs,'61f9cb64803b37270fcc0603d97f5f47808212bf');assert.equal(fs,'b437a0f918cdf8c58a46f6abb50b5fb346f96848');
 const bi=isNative?base.input.sha256:base.provenance.fixtureSha256,fi=isNative?final.input.sha256:final.provenance.fixtureSha256;assert.equal(bi,fi);
 return strictCompare(base.raw,final.raw,policy.entries,{fixtureSha256:bi,source:bs+'..'+fs,arm:'baseline-vs-final-'+(isNative?'native':base.provenance.consumer)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [a,b,p,mode]=process.argv.slice(2);const read=x=>JSON.parse(readFileSync(x,'utf8'));const result=mode?.startsWith('pair:')?compareObservationPair(read(a),read(b),read(p),mode.slice(5)):mode==='public-routes'?comparePublicRoutes(read(a),read(b),read(p)):mode==='cross-revision'?compareRevisions(read(a),read(b),read(p)):compareReceipts(read(a),read(b),read(p));console.log(JSON.stringify(result,null,2));if(result.result!=='MATCH_OR_EXACT_EXPECTED_DIFF')process.exitCode=1;}
 catch(error){console.log(JSON.stringify({result:'INCOMPLETE',error:String(error)},null,2));process.exitCode=1;}
}
