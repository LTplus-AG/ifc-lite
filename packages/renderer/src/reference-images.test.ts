/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceImageManager } from './reference-images.js';
import { referenceImageHit } from './reference-image-hit.js';
import type { ReferenceImageInput } from './reference-image-types.js';

Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, UNIFORM: 64, COPY_DST: 8 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 } });
const ray = { origin: { x: .5, y: .5, z: 5 }, direction: { x: 0, y: 0, z: -1 } };
function input(id = 'drawing', z = 0): ReferenceImageInput {
  return { id, bitmap: { width: 2, height: 2 } as ImageBitmap,
    corners: [[0,1,z],[1,1,z],[1,0,z],[0,0,z]], visible: true, locked: false, opacity: 1 };
}
function fixture() {
  const resources: { destroyed: number; destroy(): void }[] = [];
  const validations: ((error: GPUError | null) => void)[] = [];
  const failures = { copy: false };
  let scopePops = 0;
  let pipelineCount = 0, scenePicks = 0;
  const resource = () => { const r = { destroyed: 0, destroy() { this.destroyed++; }, createView: () => ({}) }; resources.push(r); return r; };
  const gpu = { limits: { maxTextureDimension2D: 4096 }, createShaderModule: () => ({}),
    createRenderPipeline: () => { pipelineCount++; return { getBindGroupLayout: () => ({}) }; }, createSampler: () => ({}),
    createTexture: resource, createBuffer: resource, createBindGroup: () => ({}),
    pushErrorScope() {}, popErrorScope: () => ++scopePops % 2 === 0 ? Promise.resolve(null) : new Promise<GPUError | null>(resolve => validations.push(resolve)),
    queue: { writeBuffer() {}, copyExternalImageToTexture() { if (failures.copy) throw new Error('copy failed'); } },
  } as unknown as GPUDevice;
  let occluder = Infinity;
  const manager = new ReferenceImageManager({ requestRender() {}, ray: () => ray, sceneDistance: async () => { scenePicks++; return occluder; } });
  manager.init(gpu, 'bgra8unorm', 4);
  const set = async (image: ReferenceImageInput) => { const promise = manager.set(image); validations.shift()!(null); await promise; };
  return { manager, resources, validations, failures, set, pipelineCount: () => pipelineCount, scenePicks: () => scenePicks,
    occlude: (distance: number) => { occluder = distance; } };
}

test('reference selection is nearest, depth bounded, double sided and separate from IFC identity (#4308)', async () => {
  const f = fixture();
  await f.set(input('reference:far', 0)); await f.set(input('reference:near', 2));
  assert.equal((await f.manager.pick(1, 1))?.referenceId, 'reference:near');
  f.occlude(2); assert.equal(await f.manager.pick(1, 1), null);
  f.occlude(Infinity);
  await f.set({ ...input('reference:near', 2), locked: true });
  assert.equal((await f.manager.pick(1, 1))?.referenceId, 'reference:far');
  await f.set({ ...input('reference:far', 0), visible: false });
  assert.equal(await f.manager.pick(1, 1), null);
  assert.equal(referenceImageHit('back', input().corners, { origin: { x:.5,y:.5,z:-1 }, direction: { x:0,y:0,z:1 } }, Infinity)?.distance, 1);
  f.manager.destroy();
  assert.ok(f.resources.every(r => r.destroyed === 1));
});

test('failed replacement retains the old image, late uploads after remove or loss release exactly once (#4308)', async () => {
  const f = fixture(); await f.set(input());
  const bad = f.manager.set(input('drawing', 2));
  f.validations.shift()!({ message: 'injected validation failure' } as GPUError);
  await assert.rejects(bad, /validation failure/);
  assert.equal((await f.manager.pick(1, 1))?.distance, 5);
  const late = f.manager.set(input('drawing', 3)); f.manager.remove('drawing');
  f.validations.shift()!(null); await late;
  assert.equal(await f.manager.pick(1, 1), null);
  const lost = f.manager.set(input('new')); f.manager.destroy(); f.validations.shift()!(null); await lost;
  assert.ok(f.resources.every(r => r.destroyed === 1));
});

test('upload throw releases partial allocations, and older completion cannot replace newer content (#4308)', async () => {
  const f = fixture(); f.failures.copy = true;
  const bad = f.manager.set(input()); f.validations.shift()!(null); await assert.rejects(bad, /copy failed/);
  assert.ok(f.resources.every(r => r.destroyed === 1));
  f.failures.copy = false;
  const old = f.manager.set(input('same', 0)), newer = f.manager.set(input('same', 2));
  f.validations[1](null); await newer; f.validations[0](null); await old;
  assert.equal((await f.manager.pick(1, 1))?.distance, 3);
  f.manager.destroy(); assert.ok(f.resources.every(r => r.destroyed === 1));
});

test('georeferenced quad keeps millimetre ray location and rejects misses/parallel rays (#4308)', () => {
  const base = 5e6, image = input();
  const corners = image.corners.map(p => [p[0]+base,p[1]+base,p[2]]) as unknown as ReferenceImageInput['corners'];
  const hit = referenceImageHit('survey', corners, { origin: { x:base+.001,y:base+.001,z:2 }, direction: { x:0,y:0,z:-1 } }, Infinity);
  assert.equal(hit?.point[0], base+.001);
  assert.equal(referenceImageHit('outside', corners, ray, Infinity), null);
  assert.equal(referenceImageHit('parallel', image.corners, { ...ray, direction: { x:1,y:0,z:0 } }, Infinity), null);
});

test('unchanged registered upload reuses GPU resources and cancelled replacement preserves its image (#4308)', async () => {
  const f = fixture(), original = input(); await f.set(original);
  const resourceCount = f.resources.length;
  await f.manager.set({ ...original });
  assert.equal(f.resources.length, resourceCount);
  const abort = new AbortController(), pending = f.manager.set(input('drawing', 2), abort.signal);
  abort.abort(); f.validations.shift()!(null); await pending;
  assert.equal((await f.manager.pick(1, 1))?.distance, 5);
  f.manager.destroy(); assert.ok(f.resources.every(r => r.destroyed === 1));
});

test('ordinary viewer and locked pages create no reference pipeline or redundant scene pick (#4308)', async () => {
  const f = fixture();
  assert.equal(await f.manager.pick(0, 0), null);
  assert.equal(f.pipelineCount(), 0); assert.equal(f.scenePicks(), 0);
  await f.set({ ...input(), locked: true });
  assert.equal(f.pipelineCount(), 1);
  assert.equal(await f.manager.pick(0, 0), null); assert.equal(f.scenePicks(), 0);
  f.manager.destroy();
});
