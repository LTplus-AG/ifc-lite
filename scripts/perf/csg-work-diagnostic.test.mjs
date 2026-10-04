// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// #6516 prepared consumer/ABI invariants; in-memory handles are NOT real-WASM proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const readerUrl = new URL('./csg-work-diagnostic.mjs', import.meta.url);
test('#6516 a real Node consumer preserves ordered observations and rejects unsafe tuples', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const { observedEntries } = await import(${JSON.stringify(readerUrl.href)});
    const entries = [[0, 4294967295, 0], [3, 8, 2], [3, 8, 2]];
    assert.deepEqual(observedEntries(entries), entries);
    assert.throws(() => observedEntries([[0, 4294967296, 0]]), /INVALID_CENSUS_TUPLE/);
  `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  // Assert the consumer's outcome without echoing loader diagnostics as test
  // output. Deleting the new reader must fail a running consumer assertion,
  // rather than prevent this whole test file from loading (#6516 revert oracle).
  assert.equal(result.status, 0, 'the real Node consumer could not satisfy the tuple invariants');
  assert.equal(result.signal, null);
});

// In-process ownership controls additionally exercise the available reader.
// The child consumer above remains executable when a whole-file revert removes
// the reader, so that case still produces an actual failing assertion.
if (existsSync(readerUrl)) {
const { bounds, observedEntries, sourceJob, completePopulation,
  fingerprintConvertedMeshes, fingerprintCollection, observeOriginalBatches, observeBatches } = await import(readerUrl.href);

const source = { sha256: 'a'.repeat(64), bytes: 100 };
const job = () => sourceJob(new Uint32Array([344, 10, 20]), 0, source);
const row = ordinal => ({ ordinal, ...job(), meshes: 0, triangles: 0,
  raw24MeshMultisetSha256: 'b'.repeat(64), counters: [] });

test('#6516 tuple order, duplicate multiplicity and u32 boundary stay observed data', () => {
  const entries = [[0, 0xffffffff, 0], [3, 8, 2], [3, 8, 2]];
  assert.deepEqual(observedEntries(entries), entries);
  assert.deepEqual(observedEntries([]), []); // Never implies zero work; labels state UNVERIFIED.
});
test('#6516 malformed/unknown/unsafe census values refuse, never clamp', () => {
  for (const input of [null, {}, [[0,1]], [[0,1,2,3]], [[4,1,2]], [[-1,1,2]],
    [[0,NaN,2]], [[0,1.5,2]], [[0,0x100000000,2]], [[0,'1',2]]]) {
    assert.throws(() => observedEntries(input), /INVALID_CENSUS/);
  }
});
test('#6516 serialization population cap preserves the full cap then refuses', () => {
  assert.equal(observedEntries(Array.from({ length: bounds.recordsPerDrain }, () => [0,1,1])).length,
    bounds.recordsPerDrain);
  assert.throws(() => observedEntries(Array.from({ length: bounds.recordsPerDrain + 1 }, () => [0,1,1])),
    /INVALID_CENSUS_POPULATION/);
});
test('#6516 source job keys bind actual original span/source while keeping duplicates', () => {
  const a=job(); assert.deepEqual(a.sourceJobTriple,[344,10,20]);
  assert.equal(a.sourceJobKey,job().sourceJobKey);
  const changedSpan=sourceJob(new Uint32Array([344,11,20]),0,source);
  const changedSource=sourceJob(new Uint32Array([344,10,20]),0,{...source,sha256:'c'.repeat(64)});
  assert.notEqual(a.sourceJobKey,changedSpan.sourceJobKey);
  assert.notEqual(a.sourceJobKey,changedSource.sourceJobKey);
  const p=completePopulation();p.add(row(0));p.add(row(1));
  p.add({...row(2),...changedSpan});p.add({...row(3),...changedSource});
  assert.deepEqual(p.rows.map(r=>r.duplicateOccurrence),[0,1,0,0]);
  assert.equal(p.rows[0].sourceJobKey,p.rows[1].sourceJobKey);
});
test('#6516 wrong triple layout/index and out-of-source or empty spans refuse', () => {
  for (const triples of [[344,10,20],new Uint32Array([344,10]),new Uint32Array([0,10,20]),
    new Uint32Array([344,20,20]),new Uint32Array([344,10,101])]) {
    assert.throws(() => sourceJob(triples,0,source), /INVALID_SOURCE_JOB/);
  }
  assert.throws(() => sourceJob(new Uint32Array([344,10,20]),1,source), /INVALID_SOURCE_JOB/);
});
test('#6516 complete observed row bound retains every duplicate and refusal stays sticky', () => {
  const p=completePopulation(); for(let i=0;i<bounds.jobs;i++)p.add(row(i));
  assert.equal(p.rows.length,bounds.jobs);assert.equal(p.rows[0].sourceJobKey,p.rows.at(-1).sourceJobKey);
  assert.equal(p.rows[0].duplicateOccurrence,0);assert.equal(p.rows.at(-1).duplicateOccurrence,bounds.jobs-1);
  assert.throws(() => p.add(row(bounds.jobs)),/BOUND_EXCEEDED/);
  assert.equal(p.status().observedRowsRetainedWithoutClipping,false);
  assert.throws(() => p.add(row(bounds.jobs+1)),/BOUND_EXCEEDED/);
  assert.equal(p.rows.length,bounds.jobs);
});
test('#6516 report UTF8 byte budget refuses without clipping into complete success', () => {
  const p=completePopulation();const heavy={...row(0),counters:Array.from({length:bounds.recordsPerDrain},()=>[3,0xffffffff,0xffffffff])};
  assert.throws(() => {for(let i=0;i<bounds.jobs;i++)p.add({...heavy,ordinal:i});},/BOUND_EXCEEDED/);
  assert.equal(p.status().observedRowsRetainedWithoutClipping,false);
  assert.ok(p.status().retainedRowBytes<bounds.reportBytes);
});
const mesh = () => {
  const positions=new Float32Array(new ArrayBuffer(44),4,9);positions.set([0,0,0,1,0,0,0,1,0]);
  return {expressId:344,origin:[1,2,3],color:[.5,.6,.7,1],positions,
    normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2])};
};
test('#6516 exact stock converted byte-layout recipe includes typed view offsets', () => {
  assert.deepEqual(fingerprintConvertedMeshes([mesh()]),{hashes:['7de2c5678ac809a36473b7d36dcbd23ae3168838d676eff501e7eb2e051d38ac'],triangles:1});
});
test('#6516 actual channel mutations change both independently tagged fingerprints', () => {
  const m=mesh();const before=fingerprintConvertedMeshes([m]);m.normals[0]=1;
  assert.notEqual(before.hashes[0],fingerprintConvertedMeshes([m]).hashes[0]);
  let frees=0;const raw={...m,textureRgba:new Uint8Array([1,2,3,4]),free(){frees++;}};
  const collection={length:1,get(){return raw;}};const first=fingerprintCollection(collection);
  raw.textureRgba[2]=7;const next=fingerprintCollection(collection);
  assert.notEqual(first.hashes[0],next.hashes[0]);assert.equal(frees,2);
});
test('#6516 ordinary observer transfers original ownership and frees on fingerprint failure', () => {
  let handlesFreed=0;let collectionsFreed=0;const m={...mesh(),free(){handlesFreed++;}};
  const originalCollection={length:1,get(){return m;},free(){collectionsFreed++;}};
  const api={processGeometryBatch(){return originalCollection;}};const original=api.processGeometryBatch;
  const restore=observeOriginalBatches(api,output=>assert.equal(output.triangles,1));
  assert.equal(api.processGeometryBatch(),originalCollection);assert.equal(handlesFreed,1);assert.equal(collectionsFreed,0);
  restore();assert.equal(api.processGeometryBatch,original);
  const restoreBad=observeOriginalBatches(api,()=>{throw new Error('independent callback failure');});
  assert.throws(()=>api.processGeometryBatch(),/independent callback failure/);assert.equal(collectionsFreed,1);restoreBad();
});

test('#6516 diagnostic replays duplicate ORIGINAL triples and transfers reference collection', () => {
  let handleFrees=0;let collectionFrees=0;const calls=[];const rows=[];
  const api={owner:true,processGeometryBatch(bytes,jobs){
    assert.equal(this.owner,true);calls.push({bytes,jobs});
    return {length:jobs.length/3,get(){return {...mesh(),free(){handleFrees++;}};},
      free(){collectionFrees++;}};
  }};
  const original=api.processGeometryBatch;const bytes=new Uint8Array(100);
  const jobs=new Uint32Array([344,10,20,344,10,20]);let batches=0;
  const restore=observeBatches(api,()=>[],r=>rows.push(r),()=>batches++,source);
  const collection=api.processGeometryBatch(bytes,jobs);
  assert.equal(calls.length,3);assert.equal(calls[0].jobs,jobs);
  assert.ok(calls.every(c=>c.bytes===bytes));assert.deepEqual(Array.from(calls[1].jobs),[344,10,20]);
  assert.deepEqual(Array.from(calls[2].jobs),[344,10,20]);
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.ordinal),[0,1]);
  assert.deepEqual(rows[0].sourceJobTriple,[344,10,20]);assert.equal(rows[0].sourceJobKey,rows[1].sourceJobKey);
  assert.equal(collection.length,2);assert.equal(batches,1);assert.equal(handleFrees,4);
  assert.equal(collectionFrees,2);collection.free();restore();assert.equal(collectionFrees,3);
  assert.equal(api.processGeometryBatch,original);
});
test('#6516 diagnostic mismatch refuses and frees original plus replay collections', () => {
  let collectionFrees=0;let calls=0;const api={processGeometryBatch(){
    const returned={...mesh(),free(){}};if(calls++>0)returned.normals[0]=1;
    return {length:1,get(){return returned;},free(){collectionFrees++;}};
  }};
  const restore=observeBatches(api,()=>[],()=>{},()=>{},source);
  assert.throws(()=>api.processGeometryBatch(new Uint8Array(100),new Uint32Array([344,10,20])),
    /Individual jobs differ from canonical streaming batch/);
  assert.equal(collectionFrees,2);restore();
});
}
