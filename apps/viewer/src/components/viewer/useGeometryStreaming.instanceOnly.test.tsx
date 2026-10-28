/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef, useState } from 'react';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Camera } from '../../../../../packages/renderer/src/camera.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { cleanup, render, advance } from '@/test/render.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';

interface Input { geometry: MeshData[] | null; source?: MeshData[]; shard?: ArrayBuffer; streaming: boolean }
let update: (input: Input) => void;
const flat: MeshData = { expressId: 91, positions: Float32Array.of(20,0,0,21,0,0,20,1,0), normals: new Float32Array(9), indices: Uint32Array.of(0,1,2), color: [0.6,0.6,0.6,1] };
const box = { min: { x: 20, y: 0, z: 0 }, max: { x: 21, y: 1, z: 0 } };
const coordinateInfo: CoordinateInfo = { originalBounds: box, shiftedBounds: box, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
function View({ renderer }: { renderer: Renderer }) {
  const [input, set] = useState<Input>({ geometry: null, streaming: false });update = set;
  const rendererRef = useRef<Renderer | null>(renderer), geometryBoundsRef = useRef(box);
  const clearColorRef = useRef<[number, number, number, number]>([0,0,0,1]);
  useGeometryStreaming({ rendererRef, geometry: input.geometry, appearanceSourceGeometry: input.source ?? input.geometry ?? [],
    coordinateInfo, isInitialized: true, isStreaming: input.streaming, geometryBoundsRef, clearColorRef,
    pendingInstancedShards: input.shard ? [{ modelId: 'm', bytes: input.shard }] : null,
    clearInstancedShards: () => set(current => ({ ...current, shard: undefined })),
    pendingMeshColorUpdates: null, pendingColorUpdates: null, pendingMeshRemovals: null,
    pendingMeshTranslations: null, pendingMeshRotations: null,
    clearPendingMeshColorUpdates() {}, clearPendingColorUpdates() {}, clearPendingMeshRemovals() {},
    pruneGeometryMeshes() {}, clearPendingMeshTranslations() {}, clearPendingMeshRotations() {} });
  return null;
}
function harness() {
  const native = appearanceInstanceScene([]), camera = new Camera(), calls: string[] = [];
  const renderer = { getScene: () => native.scene, getGPUDevice: () => native.device, getPipeline: () => native.pipeline,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), clearCaches() {}, requestRender() {} } as unknown as Renderer;
  const fit = camera.fitBoundsAdaptive.bind(camera), queue = native.scene.queueMeshes.bind(native.scene), add = native.scene.addInstancedShard.bind(native.scene);
  mock.method(camera, 'fitBoundsAdaptive', (...args: Parameters<typeof fit>) => { calls.push('fit');return fit(...args); });
  mock.method(native.scene, 'queueMeshes', (...args: Parameters<typeof queue>) => { calls.push('queue');return queue(...args); });
  mock.method(native.scene, 'addInstancedShard', (...args: Parameters<typeof add>) => { calls.push('shard');return add(...args); });
  render(<View renderer={renderer} />);return { ...native, camera, calls };
}
afterEach(() => { cleanup();mock.restoreAll(); });

it('#7955 fits a real decoded instance-only scene and resets ownership for its replacement', async () => {
  const h = harness();
  await act(async () => update({ geometry: [], shard: buildShardBytes(31), streaming: true }));
  assert.deepEqual(h.calls, ['shard','fit']);
  assert.equal(h.scene.getInstancedEntityBounds(31)?.max.x, 1);
  assert.ok(Math.abs(h.camera.getTarget().x - 0.5) < 0.01);
  await act(async () => update({ geometry: null, streaming: false }));
  const next = buildShardBytes(38);
  // Hand-built IFNS v1 instance transform: row-major translation X at byte 116.
  new DataView(next).setFloat32(116, 1000, true);
  await act(async () => update({ geometry: [], shard: next, streaming: true }));
  assert.equal(h.scene.getInstancedEntityBounds(38)?.min.x, 1000, 'fixture translates the rendered occurrence');
  assert.ok(Math.abs(h.camera.getTarget().x - 1000.5) < 0.01);
  assert.equal(h.calls.filter(call => call === 'fit').length, 2);
});

it('#7955 completion keeps the existing user-camera-moved guard', async () => {
  const h = harness();
  await act(async () => update({ geometry: [], shard: buildShardBytes(31), streaming: true }));
  h.camera.setTarget(99, 88, 77);
  const before = { ...h.camera.getTarget() };
  await act(async () => update({ geometry: [], streaming: false }));await advance(30);
  assert.deepEqual({ ...h.camera.getTarget() }, before);
  assert.equal(h.calls.filter(call => call === 'fit').length, 1);
});

it('#7955 a mixed flat/shard batch preserves queue, camera-fit, shard-upload order', async () => {
  const h = harness();
  await act(async () => update({ geometry: [flat], shard: buildShardBytes(31), streaming: true }));
  assert.deepEqual(h.calls, ['queue','fit','shard']);
  assert.ok(Math.abs(h.camera.getTarget().x - 20.5) < 0.01, 'uses the unchanged flat-batch coordinate bounds');
  assert.equal(h.calls.filter(call => call === 'fit').length, 1, 'no additional instance fit on a flat batch');
});

it('#7955 filtering flat geometry to empty does not turn its mixed batch into an instance-only fit', async () => {
  const h = harness();
  await act(async () => update({ geometry: [], source: [flat], shard: buildShardBytes(31), streaming: true }));
  assert.deepEqual(h.calls, ['shard']);
});

for (const [reason, source] of [['filtered', [flat]], ['released', []]] as const) {
it(`#7955 a ${reason} mixed-model snapshot preserves its existing camera-reset ownership on unload`, async () => {
  const h = harness();
  await act(async () => update({ geometry: [flat], shard: buildShardBytes(31), streaming: true }));
  const target = { ...h.camera.getTarget() };
  await act(async () => update({ geometry: [], source: [...source], streaming: true }));
  assert.ok(h.scene.getInstancedEntityBounds(31), 'mixed model still owns its instance after the flat snapshot is emptied');
  await act(async () => update({ geometry: null, streaming: false }));
  assert.deepEqual({ ...h.camera.getTarget() }, target, 'empty flat snapshots retain the pre-existing reset behavior');
  assert.deepEqual(h.calls, ['queue','fit','shard'], 'no extra fit or upload on clearing the snapshot/unload');
});
}
