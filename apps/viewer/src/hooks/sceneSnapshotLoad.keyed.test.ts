/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11390 follow-up: the global instance plan's keyed shards (an `IFNL` trailer
 * naming one key per template record) must draw the same whichever path uploads
 * them. A warm reopen adopting a cold load's scene snapshot uploads them through
 * `uploadSnapshotShards`, the stream through its drain. The scene joins keyed
 * records by default (only the plan writes them), so both join each key into one
 * template. Before, only the drain enabled the join, and the reopen drew one
 * template per record (C20-Institute-Var-2: 9 templates cold, 75 reopened).
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { decodeInstancedShard } from '@ifc-lite/geometry';
import { uploadSnapshotShards } from './sceneSnapshotLoad';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 };

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: ({ size }: GPUBufferDescriptor) => { const data = new ArrayBuffer(size); return { size, getMappedRange: () => data, unmap() {}, destroy() {} }; },
  createBindGroup: () => ({}),
  queue: { writeBuffer() {} },
} as unknown as GPUDevice;

/** A v1 IFNS shard: one triangle template keyed `(hi, lo)`, one instance per id at x = id. */
function keyedShard(ids: number[], hi: number, lo: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const words = 8 + 6 + 6 /* origin f64 x3 */ + ids.length * 22 + 9 + 9 + 3 + 2 + 2;
  const view = new DataView(new ArrayBuffer(words * 4));
  let at = 0;
  const u32 = (v: number) => { view.setUint32(at, v, true); at += 4; };
  const f32 = (v: number) => { view.setFloat32(at, v, true); at += 4; };
  for (const v of [0x4946_4e53, 1, 1, ids.length, 9, 9, 3, 0]) u32(v);
  for (const v of [0, 9, 0, 9, 0, 3]) u32(v);
  for (let k = 0; k < 3; k++) { view.setFloat64(at, 0, true); at += 8; }
  for (const id of ids) {
    u32(0); u32(id);
    for (const c of [0.5, 0.5, 0.5, 1]) f32(c);
    for (const v of [1, 0, 0, id, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) f32(v);
  }
  positions.forEach(f32); normals.forEach(f32); indices.forEach(u32);
  for (const v of [0x4946_4e4c, 1, hi, lo]) u32(v);
  return view.buffer;
}

const shards = () => [keyedShard([1, 2, 3], 21, 7), keyedShard([4, 5], 21, 7), keyedShard([6], 0x8000_0001, 9)];

function templateCounts(scene: Scene): number[] {
  return scene.getInstancedTemplates().map((t) => t.instanceCount);
}

it('#11390 follow-up: a reopen adopting the snapshot joins keyed shards exactly as the stream did', () => {
  const streamed = new Scene();
  for (const bytes of shards()) streamed.addInstancedShard(device, decodeInstancedShard(new Uint8Array(bytes)), 0);

  const reopened = new Scene();
  assert.equal(uploadSnapshotShards(reopened, device, 'keyed-reopen', shards()), true);

  assert.deepEqual(templateCounts(reopened), templateCounts(streamed));
  assert.deepEqual(templateCounts(reopened), [5, 1], 'one template per key, not one per record');
  assert.equal(reopened.getResidentGpuBytes().instanced, streamed.getResidentGpuBytes().instanced, 'same GPU bytes');
  assert.equal(reopened.hasKeyedTemplates(), true);
});
