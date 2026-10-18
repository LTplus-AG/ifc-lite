// Pure receipt checks. No producer/model imports. SOURCE ONLY.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeTyped,validateExact,exact} from './exact-wire.mjs';
import {MESH_GETTERS,COLLECTION_GETTERS,COLUMN_TYPES} from './public-contract.mjs';
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function requireInputPins(requiredPaths,inputs){const pinned=new Set(inputs.map(v=>resolve(v.path)));for(const path of requiredPaths)if(!pinned.has(resolve(path)))throw Error('required runtime/input pin missing: '+path);return true;}
export function wasmAdapterInputPins(adapterUrl){return ['capture-wasm.mjs','exact-wire.mjs','public-contract.mjs','schema.mjs','output-reservation.mjs'].map(name=>fileURLToPath(new URL(name,adapterUrl)));}
export function verifyInputPins(inputs){for(const pin of inputs){const b=readFileSync(pin.path);if(b.length!==pin.bytes||createHash('sha256').update(b).digest('hex')!==pin.sha256)throw Error('case input pin mismatch: '+pin.path);}return true;}
const ok=(v,m)=>assert.ok(v,'INCOMPLETE: '+m);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const rawNumber=v=>typeof v==='number'||(v&&Object.keys(v).length===1&&['-0','NaN','Infinity','-Infinity'].includes(v.number));
export function nativeWire(w){
 ok(w&&/^(Float32Array|Float64Array|Uint32Array|Uint8Array)$/.test(w.typedArray),'native typed kind');
 const C={Float32Array,Float64Array,Uint32Array,Uint8Array}[w.typedArray];
 ok(count(w.length)&&w.byteLength===w.length*C.BYTES_PER_ELEMENT,'native cardinality');
 ok(typeof w.bytesHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(w.bytesHex),'canonical native hex');
 const b=Buffer.from(w.bytesHex,'hex');ok(b.length===w.byteLength,'native byte length');
 return exact(new C(Uint8Array.from(b).buffer));
}
function inventory(o,keys){
 ok(o?.getters&&o.getterPresence,'getter inventory');
 for(const k of keys)ok(o.getterPresence[k]===true&&Object.hasOwn(o.getters,k),'required getter '+k);
 ok(Object.keys(o.getterPresence).length===Object.keys(o.getters).length,'inventory alignment');validateExact(o.getters);
}
function mesh(g){
 for(const k of ['expressId','vertexCount','triangleCount'])ok(count(g[k]),k);
 const p=decodeTyped(g.positions,'Float32Array'),n=decodeTyped(g.normals,'Float32Array'),ix=decodeTyped(g.indices,'Uint32Array');
 ok(p.length===g.vertexCount*3&&n.length===p.length&&ix.length===g.triangleCount*3,'mesh cardinality');
 ok([...p,...n].every(Number.isFinite)&&[...ix].every(x=>x<g.vertexCount),'finite/in-range geometry');
 ok(decodeTyped(g.color,'Float32Array').length===4,'RGBA');ok(decodeTyped(g.origin,'Float64Array').length===3,'origin');
}
export function validateWorkContract(c,meshes,triangles){
 ok(c&&typeof c.id==='string'&&c.id.length>0,'named real work contract');
 for(const k of ['minMeshes','minTriangles'])ok(count(c[k]),'contract '+k);
 ok(typeof c.allowEmpty==='boolean'&&Array.isArray(c.requiredMeshIds)&&Array.isArray(c.forbiddenMeshIds),'complete work contract');
 ok(c.allowEmpty||(c.minMeshes>0&&c.minTriangles>0),'nonempty case needs positive mesh/triangle floors');
 ok(meshes.length>=c.minMeshes&&triangles>=c.minTriangles,'positive fixture work floors');
 ok(c.allowEmpty||meshes.length>0,'unexpected empty geometry');
 const ids=new Set(meshes.map(m=>m.id));
 for(const id of c.requiredMeshIds)ok(ids.has(id),'missing positive fixture element '+id);
 for(const id of c.forbiddenMeshIds)ok(!ids.has(id),'refused element emitted geometry '+id);
 return true;
}
// This is the public return contract, not an index or planner reconstruction.
export const COMBINED_ONCE_FIELDS=('jobs totalJobs unitScale unitRefused planeAngleToRadians rtcOffset needsShift buildingRotation voidKeys voidCounts voidValues styleIds styleColors styleFinishes materialElementIds materialColorCounts materialColors').split(' ');
export function snapshotCombinedOnceReturn(value,onFailure){
 const result={};
 for(const key of new Set([...COMBINED_ONCE_FIELDS,...Object.keys(value??{})])){
  if(!value||!Object.hasOwn(value,key)){
   result[key]={missingGetter:true};onFailure('missing buildPrePassOnce return field '+key);continue;
  }
  try{result[key]=exact(value[key]);}
  catch(error){result[key]={getterError:String(error)};onFailure('buildPrePassOnce return field '+key+': '+String(error));}
 }
 return result;
}
export function validateCombinedOnceReturn(value){
 ok(value&&typeof value==='object','public buildPrePassOnce result');
 for(const key of COMBINED_ONCE_FIELDS){ok(Object.hasOwn(value,key),'missing buildPrePassOnce return field '+key);ok(!value[key]?.missingGetter&&!value[key]?.getterError,'unavailable buildPrePassOnce return field '+key);}
 validateExact(value);
 const jobs=decodeTyped(value.jobs,'Uint32Array');
 ok(count(value.totalJobs)&&jobs.length%3===0&&jobs.length/3===value.totalJobs,'combined once job triples/total');
 const voidKeys=decodeTyped(value.voidKeys,'Uint32Array'),voidCounts=decodeTyped(value.voidCounts,'Uint32Array'),voidValues=decodeTyped(value.voidValues,'Uint32Array');
 ok(voidKeys.length===voidCounts.length&&voidCounts.reduce((n,x)=>n+x,0)===voidValues.length,'combined once void column widths');
 const styleIds=decodeTyped(value.styleIds,'Uint32Array'),styleColors=decodeTyped(value.styleColors,'Uint8Array'),styleFinishes=decodeTyped(value.styleFinishes,'Float32Array');
 ok(styleColors.length===styleIds.length*4&&styleFinishes.length===styleIds.length*2,'combined once style/finish column widths');
 const materialIds=decodeTyped(value.materialElementIds,'Uint32Array'),materialCounts=decodeTyped(value.materialColorCounts,'Uint32Array'),materialColors=decodeTyped(value.materialColors,'Uint8Array');
 ok(materialIds.length===materialCounts.length&&materialColors.length===materialCounts.reduce((n,x)=>n+x,0)*4,'combined once material column widths');
 decodeTyped(value.rtcOffset,'Float64Array');ok(value.rtcOffset.length===3,'combined once RTC width');
 ok(typeof value.unitRefused==='boolean'&&typeof value.needsShift==='boolean','combined once unit/frame flags');
 ok(rawNumber(value.unitScale),'combined once unit scale raw value');
 ok(rawNumber(value.planeAngleToRadians),'combined once angle raw value');
 ok(value.buildingRotation===null||rawNumber(value.buildingRotation),'combined once rotation raw value');
 return {jobs,voidKeys,voidCounts,voidValues,styleIds,styleColors,styleFinishes,materialIds,materialCounts,materialColors};
}
export function validateOnceRouting(raw){
 ok(raw.events.length===0&&raw.meta===null&&raw.complete===null,'once result must retain its direct public shape, not synthetic stream events');
 ok(raw.columns===null&&raw.indexInstall===null,'once API does not return public index/column installers');
 const channels=validateCombinedOnceReturn(raw.oncePublicReturn);
 const jobs=Array.from({length:channels.jobs.length/3},(_,i)=>[channels.jobs[i*3],channels.jobs[i*3+1],channels.jobs[i*3+2]]);
 assert.deepEqual(jobs,raw.jobs.map(j=>[j.id,j.start,j.end]),'readable jobs are projected only from the actual once jobs wire');
 ok(raw.optionsIdentity?.prepassMethod==='buildPrePassOnce'&&raw.optionsIdentity?.batchMethod==='processGeometryBatch','once public method identity');
 ok(raw.optionsIdentity.disabledSiteRequested===false&&raw.optionsIdentity.disabledSiteFilterSupported===false,'once cannot claim disabled-site filtering');
 ok(raw.optionsIdentity.jobsSource==='oncePublicReturn.jobs'&&raw.optionsIdentity.batchCount===1,'once job wire forwarded as one batch');
 ok(raw.optionsIdentity.apiInstanceShared===true,'once cached index and public batch share the same API instance');
 ok(raw.batches.length===1&&raw.diagnostics.length===1,'once single-batch topology');
 const batch=raw.batches[0];ok(batch.eventIndex===null,'once batch does not claim a stream callback event');
 assert.deepEqual(batch.jobsWire,raw.oncePublicReturn.jobs,'one batch receives the exact returned once jobs wire');
 const loc=raw.sitePositionSourceRecord;
 if(loc!==null){ok(loc.source==='oncePublicReturn.jobs'&&loc.ifcType==='IFCSITE','site locator provenance');ok(jobs.some(j=>j[0]===loc.id&&j[1]===loc.start&&j[2]===loc.end),'site locator must be an actual returned job triple');}
 return jobs;
}
export function validateWasmCapture(r){
 ok(r.schema==='c4-0-wasm-v1'&&r.status==='ok','WASM status');const a=r.raw;
 for(const k of ['events','jobs','meshes','batches','diagnostics','errors','refusals','cleanupErrors'])ok(Array.isArray(a[k]),k);
 ok(!a.errors.length&&!a.refusals.length&&!a.cleanupErrors.length,'errors/refusal/cleanup evidence');validateExact(a);
 const once=r.provenance.consumer==='once';let events=[],jobs=[];
 if(once){
  jobs=validateOnceRouting(a);
 }else{
  ok(a.meta&&a.complete&&a.events.at(-1)?.type==='complete','meta/complete');
  const allowed=new Set(['meta','styles','entity-index','prepass-columns','jobs','complete']);
  ok(a.events.every(e=>allowed.has(e.type)),'unknown event must be reviewed');
  events=a.events.map((e,i)=>({e,i})).filter(v=>v.e.type==='jobs');
  ok(events.length===a.batches.length&&a.diagnostics.length===a.batches.length,'batch topology');
  for(const {e} of events){const x=decodeTyped(e.jobs,'Uint32Array');ok(x.length%3===0,'job triples');ok(decodeTyped(e.affinity,'Uint32Array').length===x.length/3,'affinity');for(let j=0;j<x.length;j+=3)jobs.push([...x.slice(j,j+3)]);}
  assert.deepEqual(jobs,a.jobs.map(j=>[j.id,j.start,j.end]));ok(a.complete.totalJobs===jobs.length,'complete count');
  for(const [k,C]of Object.entries(COLUMN_TYPES))decodeTyped(a.columns[k],C);
  if(r.provenance.consumer==='columns'){
   for(const [k,C]of Object.entries({ids:'Uint32Array',starts:'Uint32Array',lengths:'Uint32Array',classes:'Uint8Array',oversizedIdStarts:'Uint32Array'}))decodeTyped(a.scan[k],C);
   ok(a.scan.handoff===-1&&a.scan.oversizedIdStarts.length===0,'scan incomplete/refused');ok(a.styleSlices.length===8,'eight individual styles');
  }else ok(a.events.filter(e=>e.type==='entity-index').length===1,'serial entity index');
 }
 let seen=0,triangles=0;
 for(const [i,b]of a.batches.entries()){
  ok(b.batchIndex===i&&b.meshStart===seen,'batch index/order');
  if(once){ok(b.eventIndex===null,'once batch has no fabricated callback event');assert.deepEqual(b.jobsWire,a.oncePublicReturn.jobs);}
  else{ok(b.eventIndex===events[i].i,'stream event order');assert.deepEqual(b.jobsWire,events[i].e.jobs);}
  inventory(b.collection,COLLECTION_GETTERS);ok(b.collection.getters.length===b.meshCount,'collection length');
  for(const m of a.meshes.slice(seen,seen+b.meshCount)){inventory(m,MESH_GETTERS);mesh(m.getters);ok(m.batchIndex===i&&m.eventIndex===b.eventIndex,'mesh batch');}
  seen+=b.meshCount;triangles+=b.collection.getters.totalTriangles;
  ok(a.diagnostics[i]?.schemaVersion===1&&a.diagnostics[i].meshCount===seen&&a.diagnostics[i].triangleCount===triangles,'pipeline counts');
 }
 ok(seen===a.meshes.length,'all mesh records retained');
 validateWorkContract(r.contract,a.meshes,triangles);
 if(r.provenance.observation.enabled){ok(r.observations&&Array.isArray(r.observations.geometry)&&Array.isArray(r.observations.prepass),'observed realms');validateObservationBuffers(r.observations);if(once)validateOnceObservations(r.observations.geometry,a);}
 else ok(r.observations===null,'uninstrumented receipt');
 return true;
}
const eventKinds=new Set(['native_jobs','element_job','element-result','representation-gate','effective-element-color','fallback-mesh','batch-job','batch-skip','native-units','batch-input']);
export function validateObservationBuffers(buffers){ok(buffers&&Array.isArray(buffers.geometry)&&Array.isArray(buffers.prepass),'separate observer buffers');validateObservations(buffers.geometry);ok(buffers.prepass.length===0,'prepass buffer is source-proven unused and must be exactly empty');return true;}
export function validateOnceObservations(events,raw){
 const inputs=events.filter(e=>e.event==='batch-input');
 ok(inputs.length===1,'missing/duplicate combined observation batch-input');
 assert.deepEqual(nativeWire(inputs[0].jobs),raw.oncePublicReturn.jobs,'combined observed batch-input jobs wire');
 const observed=events.filter(e=>e.event==='batch-job').map(e=>[e.id,e.start,e.end]);
 assert.deepEqual(observed,raw.jobs.map(j=>[j.id,j.start,j.end]),'missing/reordered combined observation batch-job');
 return true;
}
export function validateObservations(events){
 ok(Array.isArray(events),'primitive observation list');for(const e of events){
  ok(eventKinds.has(e.event),'unknown observer event');if(!['native_jobs','native-units','batch-input'].includes(e.event))ok(count(e.id),'observed id');
  if(e.event==='element_job'){
   ok(['product','type'].includes(e.kind)&&Array.isArray(e.repMaps),'actual planned job kind/maps');
   for(const m of e.repMaps)ok(Array.isArray(m)&&m.length===2&&count(m[0])&&count(m[1]),'map id/class');
   if(e.suppliedElementColor!==null)ok(nativeWire(e.suppliedElementColor).length===4,'supplied color wire');
  }
  if(['effective-element-color','fallback-mesh'].includes(e.event))ok(nativeWire(e.color).length===4,'actual evaluated color');
  if(e.event==='native_jobs'){
   ok(typeof e.stage==='string'&&Array.isArray(e.jobs),'actual stage jobs');
   for(const j of e.jobs){ok(count(j.id)&&count(j.start)&&count(j.end)&&j.end>=j.start,'native job source identity');ok(nativeWire(j.elementColor).length===4,'native planned/resolved color');}
  }
  if(['batch-skip','representation-gate'].includes(e.event)){
   const c=e.effectiveColor;ok(c?.state==='NotEvaluated'&&typeof c.reason==='string'&&typeof c.stage==='string'&&typeof c.sourceBranch==='string','source-bound non-evaluation is not missing color');
   if(e.event==='batch-skip')ok(c.reason===e.reason&&count(e.start)&&count(e.end),'skipped source job identity');
  }
  if(e.event==='element-result')ok(count(e.meshCount)&&count(e.instanceCount)&&count(e.backstop),'actual zero or positive producer result');
 }
 return true;
}
export function validateNativeCapture(r){
 ok(r.schema==='c4-0-native-v1'&&r.status==='captured_unvalidated','native status');ok(r.input?.sha256?.length===64&&count(r.input.bytes),'native input');
 ok(r.mode?.entry==='process_geometry'&&r.mode.localFrame===true,'actual native mode');ok(Array.isArray(r.raw?.meshes),'native mesh records');
 for(const m of r.raw.meshes){for(const k of ['positions','normals','indices','color','origin'])nativeWire(m[k]);ok(count(m.id)&&count(m.geometryClass),'native identity');}
 ok(count(r.raw.refusals.input)&&count(r.raw.refusals.prepass),'actual native refusal counters');
 validateWorkContract(r.contract,r.raw.meshes,r.raw.meshes.reduce((n,m)=>n+nativeWire(m.indices).length/3,0));
 if(r.observationEnabled){ok(r.observationError===null,'observer error');validateObservations(r.observations);for(const stage of ['scanned-defaults','before-unit-refusal','resolved-jobs'])ok(r.observations.filter(e=>e.event==='native_jobs'&&e.stage===stage).length===1,'one real native '+stage);const appearances=r.observations.filter(e=>e.event==='native_jobs'&&e.stage==='appearance-resolved');ok(appearances.length>0,'positive-work native receipt needs per-chunk appearance-resolved evidence');const resolved=r.observations.find(e=>e.event==='native_jobs'&&e.stage==='resolved-jobs');ok(resolved&&Array.isArray(resolved.jobs),'resolved job order is required');const shape=j=>[j.id,j.start,j.end];let flattened=[];for(const e of appearances){ok(Array.isArray(e.jobs)&&e.jobs.length>0,'appearance chunk has ordered jobs');ok(e.jobs.every(j=>count(j.id)&&count(j.start)&&count(j.end)&&j.end>=j.start&&nativeWire(j.elementColor).length===4),'appearance job identity/color');flattened.push(...e.jobs.map(shape));}assert.deepEqual(flattened,resolved.jobs.map(shape),'ordered appearance chunks must partition resolved jobs');const expected=r.contract.expectedAppearanceChunks; if(expected!==undefined)ok(appearances.length===expected,'appearance chunk count contract');}
 return true;
}
