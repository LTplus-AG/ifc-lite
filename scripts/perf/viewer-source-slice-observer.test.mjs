/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installSourceSliceObserver, classifySourceSlices, freezeResidentSource } from './viewer-source-slice-observer.mjs';

function realm(options = {}) {
  const context = vm.createContext({});
  vm.runInContext(`globalThis.events = []; let clock = 0;
    globalThis.performance = { now() { return ++clock; } };
    globalThis.console = { log(...args) { events.push({ receiver: this === console, args }); return 17; } };
    globalThis.originalSlice = Uint8Array.prototype.slice;
    globalThis.originalLog = console.log;
    globalThis.beforeOwn = Object.hasOwn(Uint8Array.prototype, 'slice');
    globalThis.source = new SharedArrayBuffer(8);
    globalThis.bytes = new Uint8Array(source); bytes.set([1,2,3,4,5,6,7,8]);`, context);
  // Actual serialization boundary: no Node/global module closures are supplied.
  vm.runInContext(`(${installSourceSliceObserver.toString()})(${JSON.stringify({bytes:8,fileName:'O-S1.ifc',...options})})`, context);
  return { context, run: code => vm.runInContext(code, context),
    freeze: () => vm.runInContext('__ifc_lite_source_slice_observer__.freeze(source)', context) };
}
const acquired = `console.log('[useIfc] File: O-S1.ifc, size: 0.00MB (streamed→SAB)');`;
const pool = `console.log('[stream] processParallel start, fileSizeMB=0 workerCount=2');`;
const completed = `console.log('[useIfc] Stream complete for O-S1.ifc: 1ms');
  console.log('[useIfc] Data model parsing complete for O-S1.ifc: 1ms');`;

test('#6537 serialized observer records actual SAB copy, delegates native bytes and restores inherited descriptor', () => {
  const page = realm();
  assert.equal(page.run('beforeOwn'), false);
  page.run(`${acquired} globalThis.copy = bytes.slice(); ${pool} ${completed}`);
  assert.deepEqual(Array.from(page.run('copy')), [1,2,3,4,5,6,7,8]);
  page.run('copy[0]=99'); assert.equal(page.run('bytes[0]'), 1);
  const receipt = page.freeze();
  assert.equal(receipt.restorationExact, true);
  assert.equal(page.run("Object.hasOwn(Uint8Array.prototype,'slice')"), false);
  assert.equal(receipt.calls[0].inputKind, 'SharedArrayBuffer');
  assert.equal(receipt.calls[0].outputBytes, 8);
  assert.equal(receipt.calls[0].sourceId, receipt.canonicalMetadataSource.sourceId);
  assert.equal(classifySourceSlices(receipt)[0].attribution, 'source-preparation-before-default-pool');
  assert.equal(page.run('events.every(row=>row.receiver)'), true);
});

test('#6537 deferred native copy after geometry is distinct from preparation, without a total-zero claim', () => {
  const page = realm();
  page.run(`${acquired} ${pool} ${completed} bytes.slice(); console.log('[useIfcCache] Starting cache write for: O-S1.ifc (persistSource=false)');`);
  const receipt = page.freeze();
  assert.equal(classifySourceSlices(receipt)[0].attribution, 'post-geometry-before-admitted-cache-start');
  assert.equal(receipt.calls.length, 1);
});

test('#6537 real AB and SAB ranges/subviews preserve native semantics and do not inflate full-copy count', () => {
  const page = realm();
  page.run(`${acquired} globalThis.ab = new Uint8Array([8,7,6,5,4,3,2,1]);
    globalThis.copy = ab.slice(0); globalThis.partial = bytes.slice(1,4);
    globalThis.empty = bytes.slice(99);
    new Uint8Array(new SharedArrayBuffer(16),8,8).slice(); ${pool} ${completed}`);
  const receipt = page.freeze();
  assert.deepEqual(Array.from(page.run('copy')), [8,7,6,5,4,3,2,1]);
  assert.deepEqual(Array.from(page.run('partial')), [2,3,4]);
  assert.equal(page.run('empty.length'), 0);
  assert.equal(receipt.calls.length, 3);
  assert.equal(receipt.calls.filter(row => row.wholeSourceBytesCopied).length, 1);
  assert.equal(receipt.calls[0].inputKind, 'ArrayBuffer');
});

test('#6537 wrong receivers and native species errors remain original exceptions, not observer failures', () => {
  const page = realm();
  assert.equal(page.run(`(()=>{try { Reflect.apply(Uint8Array.prototype.slice,{},[]); } catch(e) { return e.name; }})()`), 'TypeError');
  assert.equal(page.run(`(()=>{const token = new Error('native species refusal');
    class Bad extends Uint8Array { static get [Symbol.species]() { throw token; } }
    try { new Bad(8).slice(); } catch(e) { return e === token; }})()`), true);
  const receipt = page.freeze(); assert.equal(receipt.calls.length, 0); assert.equal(receipt.error, null);
});

test('#6537 coercion and species run exactly once and retain their native return type', () => {
  const page = realm();
  page.run(`globalThis.coercions = 0; globalThis.result = bytes.slice({ valueOf() { coercions++; return 0; } });
    class Wide extends Uint8Array { static get [Symbol.species]() { return Uint16Array; } }
    globalThis.wide = new Wide(8).slice();`);
  assert.equal(page.run('coercions'), 1); assert.equal(page.run('wide instanceof Uint16Array'), true);
  assert.equal(page.run('wide.byteLength'), 16); assert.equal(page.run('result.byteLength'), 8);
  page.freeze();
});

test('#6537 observer cap refuses evidence while original native copying continues and restoration succeeds', () => {
  const page = realm();
  page.run(`${acquired} globalThis.last; for(let i=0;i<33;i++) last=bytes.slice(); ${pool} ${completed}`);
  assert.deepEqual(Array.from(page.run('last')), [1,2,3,4,5,6,7,8]);
  const receipt = page.freeze(); assert.equal(receipt.calls.length, 32);
  assert.equal(receipt.restorationExact, true); assert.throws(() => classifySourceSlices(receipt), /record cap/);
});

test('#6537 mid-prepass full copy or missing source ownership cannot be silently attributed', () => {
  const page = realm(); page.run(`${acquired} ${pool} bytes.slice(); ${completed}`);
  assert.throws(() => classifySourceSlices(page.freeze()), /attribution is unknown/);
  const noSource = realm(); noSource.run(`${acquired} ${pool} ${completed}`);
  const receipt = noSource.run('__ifc_lite_source_slice_observer__.freeze()');
  assert.throws(() => classifySourceSlices(receipt), /incomplete slice observer/);
});

test('#6537 exact own descriptor restores and frozen record cannot absorb teardown copies/logs', () => {
  const page = realm(); page.freeze();
  page.run(`Object.defineProperty(Uint8Array.prototype,'slice',{value:originalSlice,writable:false,configurable:true,enumerable:true});`);
  vm.runInContext(`delete globalThis.__ifc_lite_source_slice_observer__;
    (${installSourceSliceObserver.toString()})({bytes:8,fileName:'O-S1.ifc'})`, page.context);
  page.run(`${acquired} bytes.slice(); ${pool} ${completed}`);
  const receipt = page.freeze();
  page.run(`bytes.slice(); console.log('[useIfcCache] Starting cache write for: O-S1.ifc (persistSource=false)');`);
  assert.equal(receipt.calls.length, 1); assert.equal(receipt.milestones.cacheSaving, undefined);
  assert.equal(page.run("Object.getOwnPropertyDescriptor(Uint8Array.prototype,'slice').writable"), false);
  assert.equal(page.run("Object.getOwnPropertyDescriptor(Uint8Array.prototype,'slice').enumerable"), true);
});


test('#6537 same-size unrelated buffer cannot masquerade as canonical source ownership', () => {
  const page = realm(); page.run(`${acquired} new Uint8Array(8).slice(); ${pool} ${completed}`);
  assert.throws(() => classifySourceSlices(page.freeze()), /origin is not canonical/);
});


test('#6537 instrumentation failure cannot replace a successful native return even for hostile error coercion', () => {
  const page = realm();
  page.run(`performance.now = () => { throw { toString() { throw new Error('must never coerce'); } }; };
    globalThis.copy = bytes.slice();`);
  assert.deepEqual(Array.from(page.run('copy')), [1,2,3,4,5,6,7,8]);
  const receipt = page.freeze(); assert.equal(receipt.restorationExact, true);
  assert.throws(() => classifySourceSlices(receipt), /observer metadata failed/);
});


test('#6537 actual copied fallback metadata owner recognizes its upstream native SAB copy', () => {
  const page = realm(); page.run(`${acquired} globalThis.copy=bytes.slice(); ${pool} ${completed}`);
  const receipt = page.run('__ifc_lite_source_slice_observer__.freeze(copy.buffer)');
  assert.equal(receipt.canonicalMetadataSource.kind, 'ArrayBuffer');
  assert.equal(classifySourceSlices(receipt)[0].attribution, 'source-preparation-before-default-pool');
});

test('#6537 serialized resident-source freeze borrows one real byte and refuses compressed source without reading it', () => {
  const page = realm(); page.run(`${acquired} bytes.slice(); ${pool} ${completed}
    globalThis.sliceCalls=0; globalThis.data={entityCount:4,source:{isResident:true,byteLength:8,
      slice(start,end) {sliceCalls++; return bytes.subarray(start,end);} }};
    const model={id:'primary',ifcDataStore:data};
    globalThis.__ifc_lite_viewer_store__=function(){throw new Error('never invoke store hook');};
    __ifc_lite_viewer_store__.getState=function(){if(this!==__ifc_lite_viewer_store__)throw new Error('receiver lost');
      return {models:new Map([['primary',model]]),ifcDataStore:data};};`);
  const receipt = vm.runInContext(`(${freezeResidentSource.toString()})(8)`, page.context);
  assert.equal(receipt.owner.entityCount, 4); assert.equal(page.run('sliceCalls'), 1);
  const blocked = realm(); blocked.run(`globalThis.reads=0; const source={isResident:false,byteLength:8,
    slice(){reads++;throw new Error('must not decompress');}};const data={entityCount:4,source};const model={ifcDataStore:data};
    globalThis.__ifc_lite_viewer_store__={getState(){return {models:new Map([['m',model]]),ifcDataStore:data};}};`);
  assert.throws(()=>vm.runInContext(`(${freezeResidentSource.toString()})(8)`,blocked.context), /compressed\/nonresident/);
  assert.equal(blocked.run('reads'),0); blocked.freeze();
});


test('#6537 deferred milestone arming composes with actual preexisting readiness console wrapper and restores it', () => {
  const page = realm({deferMilestones:true});
  page.run(`globalThis.upstream=console.log; globalThis.readinessCalls=0;
    globalThis.readinessWrapper=function(...args){readinessCalls++;return Reflect.apply(upstream,this,args);};
    console.log=readinessWrapper; __ifc_lite_source_slice_observer__.armMilestones();
    ${acquired} bytes.slice(); ${pool} ${completed}`);
  assert.throws(()=>page.run('__ifc_lite_source_slice_observer__.armMilestones()'),/already armed/);
  const receipt=page.freeze();assert.equal(receipt.restorationExact,true);
  assert.equal(page.run('console.log===readinessWrapper'),true);assert.equal(page.run('readinessCalls'),4);
  assert.equal(classifySourceSlices(receipt)[0].attribution,'source-preparation-before-default-pool');
});
