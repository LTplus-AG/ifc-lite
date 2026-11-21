/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10880 review classes on the measure readback feeder: the neighbourhood byte
 * budget skips a chunk that does not fit without charging it; an entity that
 * has instanced occurrences is refused even when it also has flat pieces (the
 * GPU hit may be the occurrence in front); fed pieces are dropped when the
 * renderer moves a model without a store change.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { GeometryBackingRegistry } from './geometry-backing-registry';
import { ReadbackRaycastFeeder, type ReadbackRaycastHost } from './readback-raycast-feeder';
import { instancedShard } from './geometry-backing.test-fixtures';

let names = 0;
const database = () => ({ name: `feeder-review-${process.pid}-${names++}`, locks: null });
/** `triangles` triangles of entity `id` near x, all within the 1 m neighbourhood of the hit. */
function mesh(id: number, x: number, triangles = 1): MeshData {
  const positions: number[] = [];
  for (let t = 0; t < triangles; t++) positions.push(x, 0, 0, x + 0.01, 0, 0, x, 0.01, 0);
  return { expressId: id, positions: Float32Array.from(positions), normals: new Float32Array(positions.length),
    indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i), color: [1, 1, 1, 1] };
}
function host(hit: { expressId: number; worldXYZ: { x: number; y: number; z: number } }, rotation: { angle: number; px: number; pz: number } | null = null) {
  const fed: Array<readonly MeshData[] | null> = [];
  const value: ReadbackRaycastHost = {
    pick: async () => hit,
    getScene: () => ({ isGeometryDataReleased: () => true, getEntityBoundingBox: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
      placeAppearanceSource: (m: MeshData) => m, getModelRotation: () => rotation }) as never,
    setReadbackRaycastMeshes: (meshes) => { fed.push(meshes); },
  };
  return { value, fed };
}

it('#10880 a chunk over the byte budget is skipped without consuming it: the later chunk that fits is still fed', async () => {
  const registry = await GeometryBackingRegistry.open(database());
  try {
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 1 << 20 });
    // One chunk each, in this order: the hit (1), a large neighbour (2), a small neighbour (3).
    for (const piece of [mesh(1, 0.1), mesh(2, 0.2, 200), mesh(3, 0.3)]) { await backing.writer.append([piece]); await backing.writer.flush(); }
    await backing.writer.close();
    const sizes = backing.directory.chunks.map((chunk) => chunk.bytes);
    assert.equal(sizes.length, 3);
    // Room for the hit's chunk and the small one, never the large one.
    const budget = sizes[0] + sizes[2];
    assert.ok(sizes[1] > sizes[2]);
    const h = host({ expressId: 1, worldXYZ: { x: 0.1, y: 0, z: 0 } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm', budget);
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'not fed');
    assert.deepEqual(h.fed.at(-1)!.map((m) => m.expressId).sort(), [1, 3], 'the large chunk is skipped, the small one after it still fits');
  } finally { await registry.close(); }
});

it('#10880 an entity with BOTH a flat piece and an instanced occurrence is refused: the GPU hit may be the occurrence in front', async () => {
  const registry = await GeometryBackingRegistry.open(database());
  try {
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0.1)]); // its flat piece, behind
    const shard = instancedShard();
    shard.instances = [{ ...shard.instances[0], entityId: 1 }]; // and an occurrence of the same entity, in front
    await backing.writer.appendInstancedShard(shard);
    await backing.writer.close();
    const h = host({ expressId: 1, worldXYZ: { x: 0.1, y: 0, z: 0 } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable', 'never measured through an unsupported front');
    assert.match(feeder.lastError!.message, /instanced occurrences/);
  } finally { await registry.close(); }
});

it('#10880 a renderer placement change (setModelTranslation) drops fed readback pieces, with no store change', async () => {
  const { readbackFeeder } = await import('./readback-measure');
  let revision = 1;
  const listeners: Array<() => void> = [];
  const set: Array<readonly MeshData[] | null> = [];
  const renderer = {
    getPickGeometryRevision: () => revision,
    getScene: () => ({ onGeometryChange: (l: () => void) => { listeners.push(l); return () => {}; } }),
    setReadbackRaycastMeshes: (meshes: readonly MeshData[] | null) => { set.push(meshes); },
  };
  readbackFeeder(renderer as never);
  set.length = 0;
  revision++; // the GPU geometry moved
  for (const listener of listeners) listener();
  assert.deepEqual(set, [null], 'the pieces placed at the old translation are dropped');
  set.length = 0;
  for (const listener of listeners) listener(); // a change notification with no placement change
  assert.deepEqual(set, [], 'an unrelated notification keeps fed pieces');
});

it('#10880 a rotated model fails closed: subtracting its offset alone would search the wrong neighbourhood', async () => {
  const registry = await GeometryBackingRegistry.open(database());
  try {
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 1 << 20 });
    // The hit entity at local (2, 0, 0) and a neighbour beside it, each in its own chunk.
    for (const piece of [mesh(1, 2), mesh(2, 2.3)]) { await backing.writer.append([piece]); await backing.writer.flush(); }
    await backing.writer.close();
    assert.equal(backing.directory.chunks.length, 2);
    // Rotated 90 degrees about +Y through the origin: local (2, 0, 0) is the scene point (0, 0, -2).
    const h = host({ expressId: 1, worldXYZ: { x: 0, y: 0, z: -2 } }, { angle: Math.PI / 2, px: 0, pz: 0 });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable', 'never fed from a neighbourhood searched in the wrong frame');
    assert.match(feeder.lastError!.message, /rotated/);
    // The same model unrotated: its neighbour in the other chunk is fed.
    const flat = host({ expressId: 1, worldXYZ: { x: 2, y: 0, z: 0 } });
    const unrotated = new ReadbackRaycastFeeder(flat.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await unrotated.prepare(0, 0), 'fed', unrotated.lastError?.message ?? 'not fed');
    assert.deepEqual(flat.fed.at(-1)!.map((m) => m.expressId).sort(), [1, 2]);
  } finally { await registry.close(); }
});
