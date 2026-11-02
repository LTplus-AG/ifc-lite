/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564: lifecycle contract of the internal Gaussian adapter, driven through an
// injected backend so no GPU or luma module is needed. GPU behaviour is covered
// by the browser witness under examples/gaussian-splat-spike/contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GaussianSplatLayer, type GaussianLayerHost } from './gaussian/gaussian-splat-layer.js';
import { GaussianSplatError } from './gaussian/gaussian-errors.js';
import type { GaussianBackend, GaussianBackendScene, GaussianPackedSource, GaussianRowFilter, GaussianRowUpdate } from './gaussian/gaussian-backend.js';
import type { NormalizedGaussianAttributes } from './gaussian/gaussian-attributes.js';
import type { GaussianSplatHandle } from './gaussian/gaussian-types.js';

class FakeScene implements GaussianBackendScene {
  sources: GaussianPackedSource[] = [];
  updates: Array<{ rowOffset: number; rows: GaussianRowUpdate }> = [];
  filter: { include: ReadonlySet<number>; predicate: GaussianRowFilter | null } | null = null;
  destroyed = false;
  failNext: Error | null = null;
  gate: Promise<void> | null = null;
  get gpuBytes() { return this.sources.at(-1)?.opacities.byteLength ?? 0; }
  async replaceSource(source: GaussianPackedSource): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    this.sources.push(source);
  }
  updateRows(rowOffset: number, rows: GaussianRowUpdate): void { this.updates.push({ rowOffset, rows }); }
  setFilter(include: ReadonlySet<number>, predicate: GaussianRowFilter | null): void { this.filter = { include, predicate }; }
  encode(): void {}
  destroy(): void { this.destroyed = true; }
}

function harness(options: { limits?: number; reverseZ?: boolean } = {}) {
  const life = { ready: true, lost: false, disposed: false, generation: 1 };
  const deviceOf = () => ({ limits: { maxStorageBufferBindingSize: options.limits ?? 1 << 30, maxBufferSize: options.limits ?? 1 << 30 } }) as unknown as GPUDevice;
  let device: GPUDevice | null = deviceOf();
  const scenes: FakeScene[] = [];
  const failures: { nextScene: Error | null } = { nextScene: null };
  const translations = new Map<number, [number, number, number]>();
  const host: GaussianLayerHost = {
    lifetime: () => ({ ...life }), device: () => (life.lost ? null : device), adapter: () => null,
    modelTranslation: (index) => translations.get(index), requestRender: () => {},
  };
  const backend = async (): Promise<GaussianBackend> => ({
    upstreamReverseZ: options.reverseZ ?? true,
    createScene: () => { const scene = new FakeScene(); scene.failNext = failures.nextScene; failures.nextScene = null; scenes.push(scene); return scene; },
  });
  const layer = new GaussianSplatLayer(host, backend);
  return { layer, life, scenes, translations, failures, replaceDevice: () => { device = deviceOf(); }, scene: () => scenes.at(-1)! };
}

function attributes(count: number, x = 0, degree: 0 | 1 = 0): NormalizedGaussianAttributes {
  const basis = degree === 1 ? 3 : 0;
  const positions = new Float32Array(count * 3);
  for (let row = 0; row < count; row++) { positions[row * 3] = x + row * 0.001; positions[row * 3 + 1] = 1; positions[row * 3 + 2] = -2; }
  const rotations = new Float32Array(count * 4);
  for (let row = 0; row < count; row++) rotations[row * 4] = 1;
  const sphericalHarmonics = new Float32Array(count * basis * 3).fill(degree ? 0.25 : 0);
  return {
    count, positions, scales: new Float32Array(count * 3).fill(0.1), rotations, colors: new Float32Array(count * 4).fill(0.5),
    opacities: new Float32Array(count).fill(0.8), sphericalHarmonics, sphericalHarmonicsDegree: degree,
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const OPT_IN = { qualification: 'internal-unqualified' } as const;
const add = (layer: GaussianSplatLayer, count = 4, matrix = IDENTITY, extra: { signal?: AbortSignal; modelIndex?: number } = {}) =>
  layer.add({ attributes: attributes(count), placement: { matrix }, modelIndex: extra.modelIndex ?? 0 }, { ...OPT_IN, signal: extra.signal });
const code = (expected: string) => (error: unknown) => error instanceof GaussianSplatError && error.code === expected;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

test('#8564 add needs the explicit internal opt-in and never makes readiness ready', async () => {
  const { layer } = harness();
  await assert.rejects(layer.add({ attributes: attributes(2), placement: { matrix: IDENTITY }, modelIndex: 0 }, {} as never), code('not-ready'));
  const handle = await add(layer);
  assert.deepEqual(layer.getState(handle), { state: 'resident' });
  const readiness = layer.readiness();
  assert.equal(readiness.state, 'blocked');
  assert.ok(readiness.state === 'blocked' && readiness.reasons.includes('exact-mixed-transparency'));
  assert.ok(readiness.state === 'blocked' && readiness.capabilities.includes('packed-global-order'));
});

test('#8564 a missing upstream reverse-Z ordering rejects add and blocks readiness', async () => {
  const { layer } = harness({ reverseZ: false });
  await assert.rejects(add(layer), code('upstream-capability-missing'));
  await settle();
  const readiness = layer.readiness();
  assert.ok(readiness.state === 'blocked' && readiness.reasons.includes('upstream-capability-missing'));
});

test('#8564 handles are validated by identity, not by id', async () => {
  const a = harness();
  const b = harness();
  const handle = await add(a.layer);
  const forged: GaussianSplatHandle = { id: handle.id, modelIndex: handle.modelIndex };
  const foreign = await add(b.layer);
  assert.equal(foreign.id, handle.id, 'both renderers issued id 1');
  assert.equal(a.layer.remove(forged), false);
  assert.equal(a.layer.remove(foreign), false, 'a handle from another renderer never removes this asset');
  assert.deepEqual(a.layer.getState(handle), { state: 'resident' });
  assert.ok(Object.isFrozen(handle));
  assert.equal(a.layer.remove(handle), true);
  assert.equal(a.layer.remove(handle), false);
  assert.equal(a.layer.setVisible(handle, false), false);
  assert.equal(await a.layer.setPlacement(handle, { matrix: IDENTITY }), false);
  assert.deepEqual(a.layer.getState(handle), { state: 'invalid' });
  const next = await add(a.layer);
  assert.notEqual(next.id, handle.id, 'ids are never reused');
});

test('#8564 every asset packs into one upstream source in add order', async () => {
  const { layer, scene } = harness();
  const first = await add(layer, 3);
  const second = await add(layer, 5, translate(1));
  const source = scene().sources.at(-1)!;
  assert.equal(source.opacities.length, 8);
  assert.deepEqual([...source.semanticIds], [1, 1, 1, 2, 2, 2, 2, 2]);
  assert.deepEqual([...scene().filter!.include].sort(), [1, 2]);
  assert.ok(layer.setVisible(first, false));
  assert.deepEqual([...scene().filter!.include], [2]);
  assert.deepEqual(layer.getState(second), { state: 'resident' });
});

test('#8564 abort and clear during an expensive add retain nothing', async () => {
  const { layer, scene } = harness();
  const controller = new AbortController();
  const pending = add(layer, 140_000, IDENTITY, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, code('aborted'));
  assert.equal(layer.getStats().splats, 0);
  assert.equal(scene()?.sources.length ?? 0, 0, 'nothing was uploaded');
  const cleared = add(layer, 140_000);
  setTimeout(() => layer.clear(), 0);
  await assert.rejects(cleared, code('aborted'));
  assert.equal(layer.getStats().assets, 0);
});

test('#8564 dispose during an in-flight upload cannot publish', async () => {
  const { layer, scene, life } = harness();
  await add(layer, 2);
  let open!: () => void;
  scene().gate = new Promise((resolve) => { open = resolve; });
  const pending = add(layer, 2, translate(1));
  await settle();
  life.disposed = true;
  layer.release(true, true);
  open();
  await assert.rejects(pending, code('disposed'));
  assert.equal(layer.getStats().assets, 0);
});

test('#8564 a failed upload rolls back and keeps prior assets resident', async () => {
  const { layer, scene } = harness();
  const kept = await add(layer, 2);
  scene().failNext = new GaussianSplatError('resource-limit', 'simulated out-of-memory');
  await assert.rejects(add(layer, 3, translate(1)), code('resource-limit'));
  assert.equal(layer.getStats().splats, 2);
  assert.deepEqual(layer.getState(kept), { state: 'resident' });
});

test('#8564 device budgets reject before any allocation is uploaded', async () => {
  const { layer, scenes } = harness({ limits: 64 });
  await assert.rejects(add(layer, 10), code('resource-limit'));
  assert.equal(scenes.reduce((sum, s) => sum + s.sources.length, 0), 0);
});

test('#8564 loss drops residency at once; recovery re-uploads under the same handle', async () => {
  const h = harness();
  const handle = await add(h.layer, 2);
  h.life.lost = true;
  assert.deepEqual(h.layer.getState(handle), { state: 'pending' }, 'never resident during loss');
  h.layer.release(false, false); // recovery teardown(false)
  h.life.lost = false; h.life.generation = 2; h.replaceDevice();
  assert.deepEqual(h.layer.getState(handle), { state: 'pending' });
  assert.equal(h.layer.frameReady(), false, 'first frame of the new device schedules the upload');
  await settle();
  assert.deepEqual(h.layer.getState(handle), { state: 'resident' });
  assert.equal(h.scenes.length, 2);
  assert.ok(h.scenes[0].destroyed);
  assert.equal(h.layer.frameReady(), true);
});

test('#8564 failed re-upload or a cleared scene marks assets reload-required', async () => {
  const h = harness();
  const handle = await add(h.layer, 2);
  h.layer.release(false, false);
  h.replaceDevice();
  h.failures.nextScene = new GaussianSplatError('resource-limit', 'simulated re-upload failure');
  h.layer.frameReady();
  await settle();
  assert.deepEqual(h.layer.getState(handle), { state: 'failed', reason: 'reload-required' });
  assert.equal(h.layer.remove(handle), true);
  const other = harness();
  const cleared = await add(other.layer, 2);
  other.layer.release(true, false);
  assert.deepEqual(other.layer.getState(cleared), { state: 'failed', reason: 'reload-required' });
});

test('#8564 placement edits validate first, commit atomically and supersede', async () => {
  const { layer, scene } = harness();
  const handle = await add(layer, 3);
  const before = layer.getBounds(handle)!;
  await assert.rejects(layer.setPlacement(handle, { matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }), code('non-similarity-placement'));
  await assert.rejects(layer.setPlacement(handle, { matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }), code('unsupported-reflection'));
  assert.deepEqual(layer.getBounds(handle), before, 'rejected edits changed nothing');
  const superseded = layer.setPlacement(handle, { matrix: translate(5) });
  const latest = layer.setPlacement(handle, { matrix: translate(2) });
  assert.equal(await superseded, false);
  assert.equal(await latest, true);
  assert.equal(scene().updates.length, 1);
  assert.equal(scene().updates[0].rowOffset, 0);
  const after = layer.getBounds(handle)!;
  assert.ok(Math.abs(after.min[0] - (before.min[0] + 2)) < 1e-6, 'bounds follow the committed placement');
});

test('#8564 placement beyond the shared RTE anchor envelope is rejected', async () => {
  const { layer } = harness();
  await add(layer, 2);
  await assert.rejects(add(layer, 2, translate(10_000)), code('anchor-extent'));
  assert.equal(layer.getStats().assets, 1);
});

test('#8564 model translation re-places that model only; bounds are world centres', async () => {
  const h = harness();
  const moved = await add(h.layer, 2, IDENTITY, { modelIndex: 3 });
  const still = await add(h.layer, 2, IDENTITY, { modelIndex: 4 });
  const stillBefore = h.layer.getBounds(still);
  h.translations.set(3, [0, 0, 7]);
  h.layer.setModelTranslation(3);
  await settle();
  assert.ok(Math.abs(h.layer.getBounds(moved)!.min[2] - 5) < 1e-6, 'z = -2 + 7');
  assert.deepEqual(h.layer.getBounds(still), stillBefore);
});

test('#8564 removal compacts the packed source to the remaining assets', async () => {
  const { layer, scene } = harness();
  const first = await add(layer, 3);
  await add(layer, 2, translate(1));
  assert.ok(layer.remove(first));
  await settle();
  assert.equal(layer.getStats().splats, 2);
  assert.deepEqual([...new Set(scene().sources.at(-1)!.semanticIds)], [2]);
});

test('#8564 centre clipping keeps or removes whole Gaussians by centre', async () => {
  const { layer, scene } = harness();
  await add(layer, 4);
  layer.encode({
    encoder: { beginRenderPass: () => ({ end() {} }) } as unknown as GPUCommandEncoder,
    colorView: {} as GPUTextureView, depthView: {} as GPUTextureView, colorFormat: 'bgra8unorm', sampleCount: 4, width: 8, height: 8,
    frame: { getViewProjection: () => ({ m: new Float32Array(IDENTITY) }), getCameraWorld: () => [0, 0, 0] } as never,
    clip: { sectionPlane: { normal: [1, 0, 0], distance: 0.0015, flipped: false } },
  });
  const predicate = scene().filter!.predicate!;
  assert.deepEqual([0, 1, 2, 3].map((row) => predicate(1, row)), [true, true, false, false], 'x = 0, 0.001 kept; 0.002, 0.003 clipped');
});

test('#8564 abort while the upload is in flight rolls back to the previous source', async () => {
  const { layer, scene } = harness();
  const kept = await add(layer, 3);
  const before = scene().sources.at(-1)!;
  let open!: () => void;
  scene().gate = new Promise((resolve) => { open = resolve; });
  const controller = new AbortController();
  const pending = add(layer, 4, translate(1), { signal: controller.signal });
  await settle(); // packing done, upload parked
  controller.abort();
  open();
  scene().gate = null;
  await assert.rejects(pending, code('aborted'));
  assert.equal(layer.getStats().assets, 1);
  assert.deepEqual(layer.getState(kept), { state: 'pending' }, 'the scene held unpublished rows, so residency is withdrawn until re-upload');
  assert.equal(layer.frameReady(), false);
  await settle();
  assert.deepEqual(layer.getState(kept), { state: 'resident' });
  const now = scene().sources.at(-1)!;
  assert.equal(now.opacities.length, 3, 'the previous packed rows were uploaded again');
  assert.deepEqual([...now.positions], [...before.positions]);
});

test('#8564 an upload that completes after a device change never publishes', async () => {
  const h = harness();
  const kept = await add(h.layer, 2);
  const oldScene = h.scene();
  let open!: () => void;
  oldScene.gate = new Promise((resolve) => { open = resolve; });
  const pending = add(h.layer, 2, translate(1));
  await settle();
  h.life.lost = true; // loss, then recovery teardown and a replacement device
  h.layer.release(false, false);
  h.life.lost = false; h.life.generation = 2; h.replaceDevice();
  open();
  await assert.rejects(pending, code('lost'));
  assert.ok(oldScene.destroyed);
  assert.deepEqual(h.layer.getState(kept), { state: 'pending' });
  h.layer.frameReady();
  await settle();
  assert.deepEqual(h.layer.getState(kept), { state: 'resident' });
  assert.equal(h.scene().sources.at(-1)!.opacities.length, 2, 'only published rows reach the new device');
  assert.equal(h.layer.getStats().assets, 1);
});
