// SOURCE ONLY, UNRUN. Fresh independent review and separate runtime scheduling required.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reserveOutput } from './output-reservation.mjs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exact } from './exact-wire.mjs';
import { publicColumnInstall, readGetters, cleanup, MESH_GETTERS, COLLECTION_GETTERS } from './public-contract.mjs';
import { validateWasmCapture, requireInputPins, verifyInputPins, wasmAdapterInputPins, snapshotCombinedOnceReturn, validateCombinedOnceReturn } from './schema.mjs';

export async function captureWasm(planPath, outputArg) {
if (!planPath || !outputArg) throw Error('usage: node capture-wasm.mjs <reviewed-one-case.json> <NEW-output.json>');
const plan=JSON.parse(readFileSync(planPath,'utf8'));
if(plan.state!=='BOUND_REVIEWED')throw Error('unbound/source-only case cannot execute');
if(plan.schema!=='c4-0-case-v1'||!['serial','columns','once'].includes(plan.route)||!['baseline61','finalb437','site6a','c45-final'].includes(plan.revision)) throw Error('unsupported exact case');
if(plan.route==='once'&&plan.disabledSite!==false) throw Error('buildPrePassOnce has no disabledSite argument; refusing unsupported option identity');
const {wasmPath,fixturePath,route:consumer}=plan; const mode=plan.disabledSite?'disabled-site':'default';const output=resolve(outputArg);
const requiredPins=[process.execPath,plan.wasmPath,plan.gluePath,plan.fixturePath,...['prepass-routing.js','shard-style-merge.js','style-finishes.js'].map(n=>join(plan.helpersRoot,n)),...wasmAdapterInputPins(import.meta.url)];
requireInputPins(requiredPins,plan.inputs);
function guard(stage){
 try{verifyInputPins(plan.inputs);raw.inputGuards[stage]={ok:true};return true;}
 catch(error){raw.inputGuards[stage]={ok:false,error:String(error)};throw error;}
}
let prepassRealm,geometryRealm; const observerToken=plan.observation?.token;
if(plan.observation?.enabled&&!observerToken)throw Error('explicit owned observation token required');
const outputReservation=reserveOutput(output);
const raw = { events: [], jobs: [], meshes: [], meta: null, complete: null,
  diagnostics: [], batches: [], inputGuards: {before:null,after:null}, errors: [], refusals: [], cleanupErrors: [],
  sitePositionSourceRecord: null, columns: null, indexInstall: null, oncePublicReturn: null, optionsIdentity: null,
  scan: { notApplicable: 'serial public entity-index event' }, styleTrace: [], styleSlices: [], styleMerge: null };
let prepassApi, geometryApi, collection, captureStatus = 'ok';
let onceObserverStage=null, oncePrepassObservationTaken=false, onceGeometryObservationTaken=false;
let result, onceObservations=null;
let provenance = { consumer, mode, argv: [planPath, outputArg] };
function fail(message, stack = null) { captureStatus = 'incomplete'; raw.errors.push({ message, stack }); }
function cleanupFailure(message) { captureStatus = 'incomplete'; raw.cleanupErrors.push({ message }); }
try {
guard('before');
const bytes = new Uint8Array(readFileSync(fixturePath));
const wasmBytes = readFileSync(wasmPath);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const runtimeHash = hash(wasmBytes), fixtureHash = hash(bytes);
if(runtimeHash!==plan.wasmSha256 || fixtureHash!==plan.fixtureSha256 || bytes.length!==plan.fixtureBytes)throw Error('exact runtime/fixture mismatch');
const sourcePin=[plan.source.commit,plan.source.tree];
const glueHash=hash(readFileSync(plan.gluePath));
if(glueHash!==plan.glueSha256)throw Error('exact glue mismatch');
const helperHashes=Object.fromEntries(['prepass-routing.js','shard-style-merge.js','style-finishes.js'].map(n=>[n,hash(readFileSync(join(plan.helpersRoot,n)))]));
if(JSON.stringify(helperHashes)!==JSON.stringify(plan.helperHashes))throw Error('exact helper mismatch');
// The once API caches its index on the IfcAPI instance it builds; its real
// consumer therefore uses the same API instance for the subsequent public batch.
// Streaming and direct-column consumers retain their two-worker/two-realm split.
provenance = { consumer, mode, wasmSha256: runtimeHash, fixtureSha256: fixtureHash, fixtureBytes: bytes.length, glueSha256: glueHash, helperHashes, harnessCommit: sourcePin[0], harnessTree: sourcePin[1] };
const glueUrl = pathToFileURL(plan.gluePath).href;
if(consumer==='once'){
 prepassRealm=await import(`${glueUrl}?realm=combined-once`);geometryRealm=prepassRealm;prepassRealm.initSync(wasmBytes);
}else{
 prepassRealm = await import(`${glueUrl}?realm=prepass`);
 geometryRealm = await import(`${glueUrl}?realm=geometry`);
 prepassRealm.initSync(wasmBytes);geometryRealm.initSync(wasmBytes);
}
const {
  extractPrepassSpanLists, PREPASS_CLASS_STYLED_ITEM, PREPASS_CLASS_INDEXED_COLOUR_MAP,
  PREPASS_CLASS_MATERIAL_DEF_REPR, PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
  PREPASS_CLASS_REL_VOIDS, PREPASS_CLASS_REL_FILLS, PREPASS_CLASS_REL_AGGREGATES,
} = await import(pathToFileURL(join(plan.helpersRoot, 'prepass-routing.js')).href);
const { mergeShardStyleSlices } = await import(pathToFileURL(join(plan.helpersRoot, 'shard-style-merge.js')).href);
const { applyStyleFinishes } = await import(pathToFileURL(join(plan.helpersRoot, 'style-finishes.js')).href);

function ifcTypeAt(start, end) {
  const s = Buffer.from(bytes.subarray(start, Math.min(end, start + 160))).toString('ascii');
  return /^\s*#\d+\s*=\s*([A-Z0-9_]+)/.exec(s)?.[1] ?? 'UNKNOWN';
}
provenance = {source:plan.source,revision:plan.revision,consumer,mode,wasmSha256:runtimeHash,glueSha256:glueHash,helperHashes,fixtureSha256:fixtureHash,fixtureBytes:bytes.length,byteOrder:'LE',settings:{entry:'processGeometryBatch',quality:'frozen constructor default Medium',mergeLayers:'frozen constructor default false',skipSmallCuts:'frozen constructor default false',computeGeometryHashes:'frozen constructor default false',instancing:false,opening:'ordinary batch defaults',disabledSiteRequested:plan.disabledSite,prepassEntry:consumer==='once'?'buildPrePassOnce':consumer==='columns'?'buildPrePassStreamingSharded':'buildPrePassStreaming'},observation:plan.observation,casePlanSha256:hash(readFileSync(planPath))};
const disabledTypes = mode === 'disabled-site' ? ['IFCSITE'] : undefined;
prepassApi = new prepassRealm.IfcAPI(); geometryApi = consumer==='once'?prepassApi:new geometryRealm.IfcAPI();
const observerRealms=consumer==='once'?[prepassRealm]:[prepassRealm,geometryRealm];
if(plan.observation.enabled){
 for(const realm of observerRealms)for(const name of ['c4ParityBegin','c4ParityTake'])if(typeof realm[name]!=='function')throw Error('missing observation binding '+name);
 if(consumer!=='once')for(const realm of observerRealms)realm.c4ParityBegin(observerToken);
}else if(observerRealms.some(realm=>typeof realm.c4ParityBegin==='function'||typeof realm.c4ParityTake==='function'))throw Error('plain arm must use ordinary uninstrumented public binding');

let liveMeta, liveStyles, liveIndex, livePrepassColumns;
try {
  let jobChunks = [];
  const onEvent = (event) => {
    const snapshot = exact(event); raw.events.push(snapshot);
    if (event.type === 'meta') { raw.meta = snapshot; liveMeta = event; }
    if (event.type === 'complete') raw.complete = snapshot;
    if (event.type === 'prepass-columns') { raw.columns = snapshot; livePrepassColumns = event; }
    if (event.type === 'styles') { raw.stylePayload = snapshot; liveStyles = event; }
    if (event.type === 'entity-index') { liveIndex = event; }
    if (event.type === 'error' || event.type === 'refusal') (event.type === 'error' ? raw.errors : raw.refusals).push(snapshot);
    if (event.type === 'jobs') {
      const jobs = event.jobs;
      if (!(jobs instanceof Uint32Array) || jobs.length % 3 !== 0 || !(event.affinity instanceof Uint32Array) || event.affinity.length !== jobs.length / 3) throw new Error('invalid public jobs/affinity columns');
      raw.jobs.push(...Array.from({ length: jobs.length / 3 }, (_, i) => {
        const id = jobs[i * 3], start = jobs[i * 3 + 1], end = jobs[i * 3 + 2];
        return { id, ifcType: ifcTypeAt(start, end), start, end };
      }));
      jobChunks.push({ jobs, eventIndex: raw.events.length - 1 });
    }
  };
  let columns;
  if(consumer==='once'){
    if(plan.disabledSite!==false)throw new Error('buildPrePassOnce cannot honor disabledSite');
    if(plan.observation.enabled){prepassRealm.c4ParityBegin(observerToken);onceObserverStage='prepass';}
    const once=prepassApi.buildPrePassOnce(bytes);
    raw.oncePublicReturn=snapshotCombinedOnceReturn(once,fail);raw.columns=null;raw.indexInstall=null;
    validateCombinedOnceReturn(raw.oncePublicReturn);
    raw.optionsIdentity={prepassMethod:'buildPrePassOnce',prepassArguments:['fixture Uint8Array'],batchMethod:'processGeometryBatch',jobsSource:'oncePublicReturn.jobs',batchCount:1,disabledSiteRequested:plan.disabledSite,disabledSiteFilterSupported:false,apiInstanceShared:true};
    raw.stylePayload=exact({styleIds:once.styleIds,styleColors:once.styleColors,styleFinishes:once.styleFinishes});
    if(!(once.jobs instanceof Uint32Array)||once.jobs.length%3!==0||!Number.isSafeInteger(once.totalJobs)||once.jobs.length/3!==once.totalJobs)throw new Error('invalid direct combined public jobs wire');
    jobChunks.push({jobs:once.jobs,eventIndex:null});
    for(let i=0;i<once.jobs.length;i+=3){
      const id=once.jobs[i],start=once.jobs[i+1],end=once.jobs[i+2],ifcType=ifcTypeAt(start,end);
      raw.jobs.push({id,ifcType,start,end});
      if(!raw.sitePositionSourceRecord&&ifcType==='IFCSITE')raw.sitePositionSourceRecord={source:'oncePublicReturn.jobs',id,start,end,length:end-start,ifcType,meaning:'source-record locator from an actual returned job triple; not internal site_position'};
    }
    liveMeta=once;liveStyles=once;
    raw.styleTrace.push({source:'buildPrePassOnce public result',payload:raw.stylePayload,finishInstall:'setStyleFinishes(styleIds,styleFinishes)'});
    if(plan.observation.enabled){
      onceObservations={prepass:exact(JSON.parse(prepassRealm.c4ParityTake(observerToken))),geometry:null};
      oncePrepassObservationTaken=true;onceObserverStage=null;
      prepassRealm.c4ParityBegin(observerToken);onceObserverStage='geometry';
    }
    if(typeof geometryApi.setStyleFinishes!=='function')throw new Error('required pinned setStyleFinishes missing');
    applyStyleFinishes(geometryApi,once.styleIds,once.styleFinishes);
  }else if (consumer === 'serial') {
    prepassApi.buildPrePassStreaming(bytes, onEvent, 50000, disabledTypes, false);
    if (!liveIndex) throw new Error('serial prepass omitted public entity-index event');
    columns = liveIndex; raw.indexInstall = exact(liveIndex);
    if (liveIndex.oversizedIdCount !== 0 || liveIndex.malformedRecordFound !== false) throw new Error('serial scan refusal');
    geometryApi.setEntityIndex(liveIndex.ids, liveIndex.starts, liveIndex.lengths);
    publicColumnInstall(geometryApi, livePrepassColumns);
    if (!liveStyles) throw new Error('serial prepass omitted public styles event');
    if (typeof geometryApi.setStyleFinishes !== 'function') throw new Error('required pinned setStyleFinishes missing');
    applyStyleFinishes(geometryApi, liveStyles.styleIds, liveStyles.styleFinishes);
    raw.styleTrace.push({ source: 'serial styles event', payload: raw.stylePayload });
  } else {
    const scanned = prepassApi.scanEntityIndexShard(bytes, 0, bytes.length);
    columns = scanned; raw.scan = exact(scanned); raw.indexInstall = exact(scanned);
    if (scanned.oversizedIdStarts?.length !== 0 || scanned.handoff !== -1) throw new Error('scan refusal/incomplete handoff');
    prepassApi.buildPrePassStreamingSharded(bytes, onEvent, 50000, disabledTypes, false,
      scanned.ids, scanned.starts, scanned.lengths, scanned.classes);
    geometryApi.setEntityIndex(scanned.ids, scanned.starts, scanned.lengths);
    publicColumnInstall(geometryApi, livePrepassColumns);
    const lists = extractPrepassSpanLists(scanned.classes, scanned.ids, scanned.starts, scanned.lengths);
    const keys = {
      styled: PREPASS_CLASS_STYLED_ITEM, colourMap: PREPASS_CLASS_INDEXED_COLOUR_MAP,
      materialDef: PREPASS_CLASS_MATERIAL_DEF_REPR, relMaterial: PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
      void: PREPASS_CLASS_REL_VOIDS, fills: PREPASS_CLASS_REL_FILLS, aggregate: PREPASS_CLASS_REL_AGGREGATES,
    };
    const styled = lists.get(keys.styled), count = styled.length / 3, slices = [];
    for (let i = 0; i < 8; i++) {
      const from = Math.floor(i * count / 8) * 3, to = i === 7 ? count * 3 : Math.floor((i + 1) * count / 8) * 3;
      const spans = styled.slice(from, to);
      const payload = geometryApi.resolveStyledItemsShard(bytes, spans);
      raw.styleSlices.push({ sliceIndex: i, spans: exact(spans), payload: exact(payload) });
      slices.push(payload);
    }
    const merged = mergeShardStyleSlices(slices); raw.styleMerge = exact(merged);
    geometryApi.setPrepassGeometryFinishes(merged.geomIds, merged.geomFinishes);
    const finalized = geometryApi.finalizePrepassStyles(bytes, merged.orphanIds, merged.orphanColors, merged.geomIds, merged.geomColors,
      lists.get(keys.colourMap), lists.get(keys.materialDef), lists.get(keys.relMaterial), lists.get(keys.void),
      lists.get(keys.fills), lists.get(keys.aggregate), liveMeta.planeAngleToRadians);
    if (typeof geometryApi.setStyleFinishes !== 'function') throw new Error('required pinned setStyleFinishes missing');
    applyStyleFinishes(geometryApi, finalized.styleIds, finalized.styleFinishes);
    raw.styleTrace.push({ slices: 8, merged: exact(merged), finalized: exact(finalized) });
    liveStyles = finalized;
    raw.stylePayload = exact(finalized);
  }
  if (!liveMeta || !liveStyles) throw new Error('prepass omitted required meta/styles payload');
  if (raw.errors.length || raw.refusals.length) throw new Error('prepass refused/incomplete');
  if (typeof geometryApi.setStyleFinishes !== 'function') throw new Error('required pinned setStyleFinishes missing');
  // Every actual discovery job chunk is passed through the public legacy batch consumer.
  for (const [batchIndex, { jobs, eventIndex }] of jobChunks.entries()) {
    collection = geometryApi.processGeometryBatch(bytes, jobs, liveMeta.unitScale,
      ...liveMeta.rtcOffset, liveMeta.needsShift,
      liveStyles.voidKeys, liveStyles.voidCounts, liveStyles.voidValues,
      liveStyles.styleIds, liveStyles.styleColors, liveMeta.planeAngleToRadians,
      liveStyles.materialElementIds, liveStyles.materialColorCounts, liveStyles.materialColors);
    const batch = { batchIndex, eventIndex, jobsWire: exact(jobs), collection: null,
      meshStart: raw.meshes.length, meshCount: 0 };
    raw.batches.push(batch);
    try {
      const c = readGetters(collection, COLLECTION_GETTERS, fail);
      batch.collection = { getterPresence: c.presence, getters: c.values, methods: {} };
      try { batch.collection.methods.hasRtcOffset = collection.hasRtcOffset(); }
      catch (error) { fail(`hasRtcOffset: ${String(error)}`); batch.collection.methods.hasRtcOffset = { error: String(error) }; }
      const length = c.values.length;
      if (!Number.isSafeInteger(length)) throw new Error('required collection length unavailable');
      for (let i = 0; i < length; i++) {
        const mesh = collection.get(i);
        if (!mesh) throw new Error(`missing collection mesh ${i}`);
        try {
          const captured = readGetters(mesh, MESH_GETTERS, fail), id = captured.values.expressId;
          raw.meshes.push({ id, ifcType: raw.jobs.find(j => j.id === id)?.ifcType ?? 'UNMATCHED',
            batchIndex, eventIndex, meshIndex: i, getterPresence: captured.presence, getters: captured.values });
          batch.meshCount++;
        } finally { cleanup([['mesh.free', () => mesh.free()]], cleanupFailure); }
      }
    } finally {
      // Required pipeline channel is captured while the collection still exists.
      try { raw.diagnostics.push(exact(geometryApi.getPipelineDiagnostics())); }
      catch (error) {
        raw.diagnostics.push({ getterError: String(error) });
        fail(`getPipelineDiagnostics: ${String(error)}`, error?.stack);
      } finally {
        const current = collection; collection = undefined;
        cleanup([['collection.free', () => current.free()]], cleanupFailure);
      }
    }
    if (captureStatus !== 'ok') throw new Error('required getter/cleanup failure; stop further geometry batches');
  }
  if(consumer==='once'){if(!raw.oncePublicReturn||!raw.optionsIdentity)throw new Error('once public result missing');}
  else{
    if (!raw.meta || !raw.complete) throw new Error('stream did not produce both meta and complete');
    const site = columns?.ids && Array.from(columns.ids).findIndex((id, i) => ifcTypeAt(columns.starts[i], columns.starts[i] + columns.lengths[i]) === 'IFCSITE');
    if (site >= 0) raw.sitePositionSourceRecord = { id: columns.ids[site], start: columns.starts[site], length: columns.lengths[site], meaning: 'IFC site source-record locator, not internal site_position tuple' };
  }
 } catch (error) {
  fail(String(error), error?.stack);
}
} catch (error) {
  fail(String(error), error?.stack);
} finally {
  try {
    const apiCleanup=consumer==='once'?[
      ['collection.free', () => collection?.free()],
      ['once.clearPrePassCache', () => prepassApi?.clearPrePassCache()],
      ['once.free', () => prepassApi?.free()],
    ]:[
      ['collection.free', () => collection?.free()],
      ['prepass.clearPrePassCache', () => prepassApi?.clearPrePassCache()],
      ['geometry.clearPrePassCache', () => geometryApi?.clearPrePassCache()],
      ['prepass.free', () => prepassApi?.free()],
      ['geometry.free', () => geometryApi?.free()],
    ];
    cleanup(apiCleanup, cleanupFailure);
  } finally {
    try{raw.afterPinsMatch=guard('after');}catch(error){fail('final input guards: '+String(error));}
    const receipt = { schema:'c4-0-wasm-v1',status:captureStatus,contract:plan.contract,provenance,raw,observations:null };
    if(plan.observation.enabled){
      if(consumer==='once'){
        receipt.observations=onceObservations??{prepass:null,geometry:null};
        if(!oncePrepassObservationTaken&&onceObserverStage==='prepass'){
          try{receipt.observations.prepass=exact(JSON.parse(prepassRealm.c4ParityTake(observerToken)));oncePrepassObservationTaken=true;onceObserverStage=null;}catch(error){fail('observer take prepass: '+String(error));}
        }
        if(onceObserverStage==='geometry'){
          try{receipt.observations.geometry=exact(JSON.parse(prepassRealm.c4ParityTake(observerToken)));onceGeometryObservationTaken=true;onceObserverStage=null;}catch(error){fail('observer take geometry: '+String(error));}
        }
      }else{
        receipt.observations={};
        for(const [name,realm] of [['prepass',prepassRealm],['geometry',geometryRealm]]){
          try{receipt.observations[name]=exact(JSON.parse(realm.c4ParityTake(observerToken)));}catch(error){fail('observer take '+name+': '+String(error));}
        }
      }
    }
    if(plan.observation.enabled&&consumer==='once')for(const name of ['prepass','geometry'])
      if(!Array.isArray(receipt.observations?.[name]))fail('missing observation buffer '+name);
    receipt.status=captureStatus;
    try { validateWasmCapture(receipt); }
    catch (error) { fail(`validation: ${String(error)}`); receipt.status = captureStatus; }
    const receiptBytes=Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    outputReservation.write(receiptBytes);
    outputReservation.close();
    result=receipt;
  }
}

return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await captureWasm(...process.argv.slice(2));
 if(result.status!=='ok')process.exitCode=1;
}
