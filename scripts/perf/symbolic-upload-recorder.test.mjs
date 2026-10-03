/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 pure protocol controls. Actual WebGPU readback qualification remains pending.
// Existing scripts/perf/*.test.mjs catch-all can exercise these pure controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installSymbolicUploadRecorder } from './symbolic-upload-recorder.mjs';

function fixture() {
  class GPUBuffer {
    constructor(descriptor) { Object.assign(this, descriptor); this.data = new Uint8Array(this.size); this.dead = false; }
    destroy() { if (!(this instanceof GPUBuffer)) throw new TypeError('buffer receiver'); this.dead = true; return 17; }
  }
  class GPUQueue {
    writeBuffer(target, at, source, offset = 0, length) {
      if (!(this instanceof GPUQueue)) throw new TypeError('queue receiver');
      if (this.failure) throw this.failure;
      if (target.dead) throw new Error('destroyed buffer');
      // Independent functional destination memory, using source slicing in its native units.
      let selected;
      if (ArrayBuffer.isView(source) && !(source instanceof DataView)) {
        selected = source.slice(offset, length === undefined ? undefined : offset + length);
      } else {
        const raw = source instanceof DataView
          ? source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) : source;
        selected = raw.slice(offset, length === undefined ? undefined : offset + length);
      }
      const bytes = ArrayBuffer.isView(selected)
        ? new Uint8Array(selected.buffer, selected.byteOffset, selected.byteLength) : new Uint8Array(selected);
      target.data.set(bytes, at); this.calls = (this.calls ?? 0) + 1;
      if (this.mutate) new Uint8Array(source.buffer ?? source).fill(99);
      return 23;
    }
    copyExternalImageToTexture(source, destination, extent) {
      if (!(this instanceof GPUQueue)) throw new TypeError('copy receiver');
      destination.texture.copied = { source: source.source, extent }; return 29;
    }
  }
  class GPUDevice {
    constructor() { this.queue = new GPUQueue(); }
    createBuffer(descriptor) {
      if (!(this instanceof GPUDevice)) throw new TypeError('device receiver');
      if (this.failure) throw this.failure;
      return new GPUBuffer(descriptor);
    }
  }
  Object.assign(globalThis, { GPUBuffer, GPUQueue, GPUDevice });
  const device = new GPUDevice();
  const fill = { device, partitions: [] }, text = { device, instanceCount: 0 };
  const renderer = { device: { getDevice() { return device; } }, overlays: { symbolic: { fillPipeline: fill, textPipeline: text } } };
  const make = (label, size) => device.createBuffer({ label, size, usage: label.endsWith('camera') ? 72 : 40 });
  const full = buffer => device.queue.writeBuffer(buffer, 0, new Uint8Array(buffer.size));
  const partition = () => {
    const vertexBuffer = make('symbolic-fill-vbuf', 28), uniformBuffer = make('symbolic-fill-partition-camera', 160);
    full(vertexBuffer); full(uniformBuffer);
    const row = { vertexBuffer, uniformBuffer, vertexCount: 1 }; fill.partitions.push(row); return row;
  };
  return { device, fill, text, renderer, make, full, partition };
}
function setup(limits = {}) {
  const context = vm.createContext({});
  vm.runInContext(`globalThis.f = (${fixture.toString()})(); globalThis.recorder = (${installSymbolicUploadRecorder.toString()})(${JSON.stringify(limits)});`, context);
  return expression => vm.runInContext(expression, context);
}
const bytes = value => Array.from(value);

test('#6537 serialized installer retains native buffer, receiver, return and cloned source bytes', () => {
  const run = setup();
  const answer = run(`const p = f.partition(); const source = new Float32Array([11, 22, 33, 44]);
    const returned = f.device.queue.writeBuffer(p.vertexBuffer, 4, source.subarray(1, 3));
    source.fill(-123); const frozen = recorder.freeze(f.renderer);
    ({ returned, status: frozen.status, observed: frozen.buffers[0].bytes, actual: p.vertexBuffer.data });`);
  assert.equal(answer.returned, 23); assert.equal(answer.status, 'frozen');
  assert.deepEqual(bytes(answer.observed), bytes(answer.actual));
});
test('#6537 sourceOffset/size units and ordered partial overwrites match functional GPU memory', () => {
  const run = setup();
  const answer = run(`const p = f.partition();
    f.device.queue.writeBuffer(p.vertexBuffer, 4, new Uint32Array([1,2,3,4]).subarray(1), 1, 1);
    const raw = new Uint8Array([9,8,7,6,5,4,3,2,1,0,8,9]);
    f.device.queue.writeBuffer(p.vertexBuffer, 8, raw.buffer, 4, 4);
    f.device.queue.writeBuffer(p.vertexBuffer, 12, new DataView(raw.buffer,4,8), 4, 4);
    f.device.queue.writeBuffer(p.vertexBuffer, 4, new Uint32Array([50]));
    const frozen = recorder.freeze(f.renderer);
    ({ status:frozen.status, observed:frozen.buffers[0].bytes, actual:p.vertexBuffer.data });`);
  assert.equal(answer.status, 'frozen'); assert.deepEqual(bytes(answer.observed), bytes(answer.actual));
  assert.notDeepEqual(bytes(answer.observed.slice(4,8)), [0,0,0,0]);
});
test('#6537 copy occurs before native delegation can alter source storage', () => {
  const run = setup();
  const answer = run(`const p=f.partition(); f.device.queue.mutate=true;
    const source=new Uint8Array([1,2,3,4]); f.device.queue.writeBuffer(p.vertexBuffer,0,source);
    const frozen=recorder.freeze(f.renderer); ({bytes:frozen.buffers[0].bytes,actual:p.vertexBuffer.data,source});`);
  assert.deepEqual(bytes(answer.bytes), bytes(answer.actual));
  assert.deepEqual(bytes(answer.bytes.slice(0,4)), [1,2,3,4]); assert.deepEqual(bytes(answer.source), [99,99,99,99]);
});
test('#6537 original native exception identity survives and forbids successful freeze', () => {
  const run=setup();
  const answer=run(`const p=f.partition(); const failure=new Error('native rejection'); f.device.queue.failure=failure;
    let identical=false; try { f.device.queue.writeBuffer(p.vertexBuffer,0,new Uint32Array([4])); }
    catch(error) { identical=error===failure; } ({identical, receipt:recorder.freeze(f.renderer)});`);
  assert.equal(answer.identical,true); assert.equal(answer.receipt.status,'refused'); assert.equal(answer.receipt.buffers.length,0);
});
test('#6537 incomplete coverage, unlisted live buffers and wrong queue each refuse', () => {
  for (const change of [
    `const p=f.partition(); const b=f.make('symbolic-fill-vbuf',28); f.full(b);`,
    `const vertexBuffer=f.make('symbolic-fill-vbuf',28),uniformBuffer=f.make('symbolic-fill-partition-camera',160);
      f.device.queue.writeBuffer(vertexBuffer,0,new Uint32Array([1])); f.full(uniformBuffer);
      f.fill.partitions.push({vertexBuffer,uniformBuffer,vertexCount:1});`,
    `const p=f.partition(); (new GPUQueue()).writeBuffer(p.vertexBuffer,0,new Uint32Array([1]));`,
  ]) {
    const run=setup(); const answer=run(`${change} recorder.freeze(f.renderer);`);
    assert.equal(answer.status,'refused'); assert.equal(answer.buffers.length,0);
  }
});
test('#6537 destroyed buffers cannot authorize replacements bearing the same label', () => {
  const run=setup();
  const answer=run(`const old=f.partition(); const value=old.vertexBuffer.destroy(); old.uniformBuffer.destroy();
    f.fill.partitions=[]; const fresh=f.partition(); f.device.queue.writeBuffer(fresh.vertexBuffer,0,new Uint32Array([87]));
    const frozen=recorder.freeze(f.renderer); ({value, frozen, actual:fresh.vertexBuffer.data});`);
  assert.equal(answer.value,17); assert.equal(answer.frozen.status,'frozen'); assert.equal(answer.frozen.retired,2);
  assert.deepEqual(bytes(answer.frozen.buffers[0].bytes),bytes(answer.actual));
});
test('#6537 bounds and cancellation refuse but continue the original GPU write path', () => {
  for (const bound of [{bytes:16},{buffers:1},{writes:1},{}]) {
    const run=setup(bound);
    const answer=run(`const p=f.partition(); ${Object.keys(bound).length ? '' : 'recorder.cancel();'}
      const returned=f.device.queue.writeBuffer(p.vertexBuffer,0,new Uint32Array([314]));
      ({returned,first:new Uint32Array(p.vertexBuffer.data.buffer)[0],status:recorder.status()});`);
    assert.equal(answer.returned,23); assert.equal(answer.first,314); assert.equal(answer.status.status,'refused');
  }
});
test('#6537 unknown symbolic writes and mapped buffers are never silently accepted', () => {
  const run=setup();
  const answer=run(`const b=f.device.createBuffer({label:'symbolic-text-new',size:16,usage:40});
    f.device.queue.writeBuffer(b,0,new Uint32Array([1,2,3,4])); ({status:recorder.status(),actual:b.data});`);
  assert.equal(answer.status.status,'refused'); assert.deepEqual(bytes(answer.actual),[1,0,0,0,2,0,0,0,3,0,0,0,4,0,0,0]);
  const mapped=setup(); assert.equal(mapped(`f.device.createBuffer({label:'symbolic-fill-vbuf',size:28,usage:40,mappedAtCreation:true}); recorder.status();`).status,'refused');
});
test('#6537 frozen bytes exclude teardown and later writes invalidate recorder eligibility', () => {
  const run=setup();
  const answer=run(`const p=f.partition(); const frozen=recorder.freeze(f.renderer);
    f.device.queue.writeBuffer(p.vertexBuffer,0,new Uint32Array([88])); p.vertexBuffer.destroy();
    ({frozen,status:recorder.status(),actual:p.vertexBuffer.data});`);
  assert.equal(answer.frozen.status,'frozen'); assert.equal(answer.status.status,'refused');
  assert.notDeepEqual(bytes(answer.frozen.buffers[0].bytes),bytes(answer.actual));
  assert.equal(answer.status.retainedShadowBytes,0);
});
test('#6537 atlas witness requires actual texture/source/queue and matching uploaded version', () => {
  for (const mismatch of [false,true]) {
    const run=setup();
    const answer=run(`f.text.instanceCount=1;
      for (const [key,label,size] of [['instanceBuffer','symbolic-text-instances',108],['rteDeltaBuffer','symbolic-text-rte-deltas',32],
        ['uniformBuffer','symbolic-text-camera',208],['cornerBuffer','symbolic-text-corner',16]]) { f.text[key]=f.make(label,size);f.full(f.text[key]); }
      const canvas={}; f.text.atlas={canvas,atlasSize:1024,getVersion(){return 5;}};
      f.text.uploadedAtlasVersion=${mismatch ? 4 : 5};
      f.text.atlasTexture={label:'symbolic-text-atlas',width:1024,height:1024,format:'rgba8unorm',usage:22};
      const returned=f.device.queue.copyExternalImageToTexture({source:canvas,flipY:false},{texture:f.text.atlasTexture},{width:1024,height:1024});
      ({returned,receipt:recorder.freeze(f.renderer)});`);
    assert.equal(answer.returned,29); assert.equal(answer.receipt.status,mismatch?'refused':'frozen');
    if (!mismatch) { assert.equal(answer.receipt.atlas.currentVersion,5); assert.match(answer.receipt.atlas.witness,/no canvas pixels or GPU texels/); }
  }
});
test('#6537 disposal restores native methods without clobbering another observer', () => {
  const run=setup();
  assert.equal(run(`recorder.dispose(); f.device.createBuffer({label:'plain',size:4,usage:40}) instanceof GPUBuffer;`),true);
  const conflict=setup(); assert.equal(conflict(`GPUQueue.prototype.writeBuffer=function(){}; recorder.dispose();`).status,'refused');
});
test('#6537 oversized source and relabelled buffer refuse without altering native exceptions or bytes', () => {
  const run=setup();
  const answer=run(`const p=f.partition(); let name;
    try { f.device.queue.writeBuffer(p.vertexBuffer,0,new Uint8Array(128)); } catch(error) { name=error.name; }
    ({name,receipt:recorder.freeze(f.renderer)});`);
  assert.equal(answer.name,'RangeError'); assert.equal(answer.receipt.status,'refused');
  const relabel=setup(); assert.equal(relabel(`const p=f.partition(); p.vertexBuffer.label='plain'; recorder.freeze(f.renderer);`).status,'refused');
});
test('#6537 fully uploaded wrong-sized fill cameras refuse the canonical 160-byte ABI', () => {
  for (const size of [16, 208]) {
    const run = setup();
    const answer = run(`const vertexBuffer=f.make('symbolic-fill-vbuf',28);
      const uniformBuffer=f.make('symbolic-fill-partition-camera',${size});
      f.full(vertexBuffer);f.full(uniformBuffer);
      f.fill.partitions.push({vertexBuffer,uniformBuffer,vertexCount:1});
      ({nativeSize:uniformBuffer.data.byteLength,receipt:recorder.freeze(f.renderer)});`);
    assert.equal(answer.nativeSize, size);
    assert.equal(answer.receipt.status, 'refused');
    assert.equal(answer.receipt.buffers.length, 0);
    assert.match(answer.receipt.reason, /fill.*uniform size/);
  }
});

test('#6537 recorder shadow corruption fails the independent functional destination oracle', () => {
  for (const corrupt of [false, true]) {
    const run = setup();
    const answer = run(`const p=f.partition();let corruptedCopies=0;
      const nativeSet=Uint8Array.prototype.set;
      ${corrupt ? `Uint8Array.prototype.set=function(source,at=0){
        const result=Reflect.apply(nativeSet,this,[source,at]);
        // Inject a memory-copy fault only outside the independent native destination.
        if(this.byteLength===p.vertexBuffer.data.byteLength && this!==p.vertexBuffer.data){
          this[0]^=1;corruptedCopies++;
        }
        return result;
      };` : ''}
      try { f.device.queue.writeBuffer(p.vertexBuffer,0,new Uint32Array([0x01020304])); }
      finally { Uint8Array.prototype.set=nativeSet; }
      const frozen=recorder.freeze(f.renderer);
      ({frozen,actual:p.vertexBuffer.data,corruptedCopies});`);
    assert.equal(answer.frozen.status, 'frozen');
    assert.deepEqual(bytes(answer.actual.slice(0, 4)), [4, 3, 2, 1]);
    const compare = () => assert.deepEqual(bytes(answer.frozen.buffers[0].bytes), bytes(answer.actual));
    if (corrupt) {
      assert.equal(answer.corruptedCopies, 1);
      assert.throws(compare, { code: 'ERR_ASSERTION' });
    } else {
      assert.equal(answer.corruptedCopies, 0);
      compare();
    }
  }
});

test('#6537 initialized empty text owns corner/camera buffers but claims no active upload bytes', () => {
  const run=setup();
  const answer=run(`f.text.cornerBuffer=f.make('symbolic-text-corner',16);
    f.text.uniformBuffer=f.make('symbolic-text-camera',208);
    f.device.queue.writeBuffer(f.text.cornerBuffer,0,new Uint32Array([0,1,2,3]));
    f.text.instanceBuffer=null; f.text.rteDeltaBuffer=null;
    recorder.freeze(f.renderer);`);
  assert.equal(answer.status,'frozen'); assert.equal(answer.census.textInstances,0);
  assert.equal(answer.buffers.length,2); assert.ok(answer.buffers.every(row=>row.active===false && row.bytes===null));
  assert.equal(answer.buffers.find(row=>row.label==='symbolic-text-corner').completeObservedCoverage,true);
  assert.equal(answer.buffers.find(row=>row.label==='symbolic-text-camera').completeObservedCoverage,false);
  const stray=setup();
  assert.equal(stray(`f.text.instanceBuffer=f.make('symbolic-text-instances',108); recorder.freeze(f.renderer);`).status,'refused');
});
