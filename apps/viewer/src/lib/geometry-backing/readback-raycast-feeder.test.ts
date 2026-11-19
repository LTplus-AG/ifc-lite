/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { GeometryBackingRegistry, type ModelGeometryBacking } from './geometry-backing-registry';
import { GeometryUnavailableError, leaseEntityGeometry, meshIsResident, modelGeometry } from './geometry-readback';
import { ReadbackRaycastFeeder, type ReadbackRaycastHost } from './readback-raycast-feeder';
import { instancedShard } from './geometry-backing.test-fixtures';

let names = 0;
const database = () => ({ name: `feeder-test-${process.pid}-${names++}`, locks: null });

function mesh(expressId: number, x: number): MeshData {
  return { expressId, positions: Float32Array.from([x, 0, 0, x + 1, 0, 0, x, 1, 0]), normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1], origin: [0, 0, 5] };
}

async function backed(meshes: MeshData[], options = {}): Promise<{ registry: GeometryBackingRegistry; backing: ModelGeometryBacking }> {
  const registry = await GeometryBackingRegistry.open(database());
  const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 4096, ...options });
  await backing.writer.append(meshes);
  await backing.writer.close();
  return { registry, backing };
}

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
function host(state: { released: boolean; hit: { expressId: number; modelIndex?: number; worldXYZ?: { x: number; y: number; z: number } } | null },
  instanced = new Map<number, Box>()) {
  const fed: Array<readonly MeshData[] | null> = [];
  const scene = {
    isGeometryDataReleased: () => state.released,
    // Entity 4 is in the store but was never drawn (a type-filtered space).
    getEntityBoundingBox: (id: number) => (id === 4 ? null : { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    getInstancedEntityIds: () => instanced.keys(),
    getInstancedEntityBounds: (id: number) => instanced.get(id) ?? null,
    // A model translated by +100 in x, as the scene's own placement would.
    placeAppearanceSource: (m: MeshData) => ({ ...m, origin: [100 + (m.origin?.[0] ?? 0), m.origin?.[1] ?? 0, m.origin?.[2] ?? 0] as [number, number, number] }),
  };
  const value: ReadbackRaycastHost = {
    pick: async () => state.hit,
    getScene: () => scene,
    setReadbackRaycastMeshes: (meshes) => { fed.push(meshes); },
  };
  return { value, fed };
}

describe('released geometry readback for tools', () => {
  it('a resident scene is never fed and keeps its synchronous raycast', async () => {
    const { registry, backing } = await backed([mesh(1, 0)]);
    const h = host({ released: false, hit: { expressId: 1 } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'resident');
    assert.deepEqual(h.fed, [null]);
    await registry.close();
  });

  it('feeds the picked entity plus its neighbourhood, placed in the model frame, and releases old leases', async () => {
    const { registry, backing } = await backed([mesh(1, 0), mesh(2, 0.5), mesh(3, 50), mesh(4, 0.2)]);
    // The GPU hit is in the placed frame: the model is translated +100 in x.
    const state = { released: true, hit: { expressId: 1, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } };
    const h = host(state);
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(10, 10), 'fed');
    const fed = h.fed.at(-1)!;
    assert.deepEqual(fed.map((m) => m.expressId).sort(), [1, 2], 'the drawn neighbour within a metre; not the far entity, not an undrawn one');
    assert.deepEqual(fed[0].origin, [100, 0, 5], 'placed through the scene, not left in the store frame');
    assert.ok(backing.reader.retainedBytes > 0);
    state.hit = null as unknown as typeof state.hit;
    assert.equal(await feeder.prepare(10, 10), 'no-hit');
    assert.equal(h.fed.at(-1), null);
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0, 'superseded leases were released');
    await registry.close();
  });

  it('an incomplete or stale backing feeds nothing and says why, never a wrong hit', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const open = await registry.begin('m');
    await open.writer.append([mesh(1, 0)]);
    const h = host({ released: true, hit: { expressId: 1 } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => open }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable');
    assert.ok(feeder.lastError instanceof GeometryUnavailableError);
    assert.equal(h.fed.at(-1), null);
    await open.writer.close();
    await registry.invalidate('m');
    assert.equal(await feeder.prepare(0, 0), 'unavailable');
    await registry.close();
  });

  it('a newer pointer position cancels an older prefetch', async () => {
    const { registry, backing } = await backed([mesh(1, 0)]);
    let resolvePick!: (value: { expressId: number }) => void;
    const h = host({ released: true, hit: { expressId: 1 } });
    const first = new Promise<{ expressId: number }>((resolve) => { resolvePick = resolve; });
    let calls = 0;
    h.value.pick = async () => (calls++ === 0 ? first : { expressId: 1 });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    const older = feeder.prepare(0, 0);
    const newer = feeder.prepare(1, 1);
    resolvePick({ expressId: 1 });
    assert.equal(await older, 'cancelled');
    assert.equal(await newer, 'fed');
    await registry.close();
  });

  it('resident meshes answer from memory; released ones only from a complete backing', async () => {
    const live = [mesh(1, 0)];
    const { registry, backing } = await backed(live.map((m) => ({ ...m, positions: m.positions.slice(), indices: m.indices.slice() })));
    const source = { backing: () => backing };
    const resident = await leaseEntityGeometry(source, 'm', 1, live);
    assert.equal(resident.meshes[0], live[0], 'resident pieces are not read back');
    releaseCpuMeshBuffers(live);
    assert.equal(meshIsResident(live[0]), false, 'an emptied mesh still counting triangles is released');
    const read = await leaseEntityGeometry(source, 'm', 1, live);
    assert.deepEqual([...read.meshes[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    read.release();
    const batches = [];
    for await (const batch of modelGeometry(source, 'm', live)) batches.push(batch);
    assert.equal(batches.flat().length, 1);
    await assert.rejects(leaseEntityGeometry({ backing: () => undefined }, 'm', 1, live), GeometryUnavailableError);
    await registry.close();
  });

  it('an unbacked front surface is refused, never measured through', async () => {
    const { registry, backing } = await backed([mesh(1, 0)]);
    const h = host({ released: true, hit: { expressId: 77, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable');
    assert.match(feeder.lastError!.message, /has no backed geometry/);
    assert.equal(h.fed.at(-1), null, 'the flat neighbourhood behind it is not fed');
    await registry.close();
  });

  it('an instanced hit and instanced neighbours come back from backed shards, placed, opaque only', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard()); // 501 opaque, 502 translucent
    const neighbour = instancedShard();
    neighbour.instances = [{ ...neighbour.instances[0], entityId: 503 }];
    await backing.writer.appendInstancedShard(neighbour);
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } },
      new Map([[501, near], [502, near], [503, near], [504, { min: { x: 500, y: 0, z: 0 }, max: { x: 501, y: 1, z: 1 } }]]));
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message);
    const fed = h.fed.at(-1)!;
    const instanced = fed.filter((m) => m.occurrenceKey?.startsWith('readback:'));
    assert.deepEqual(instanced.map((m) => m.expressId).sort(), [501, 503], 'picked + neighbour; translucent and far ones excluded');
    assert.equal(instanced[0].origin![0] > 100, true, 'placed through the scene like flat pieces');
    await registry.close();
  });

  it('sees through overlays the resident raycast ignores, as it does', async () => {
    const { registry, backing } = await backed([mesh(1, 0)]);
    const h = host({ released: true, hit: null });
    const seen: Array<ReadonlySet<number> | undefined> = [];
    h.value.pick = async (_x, _y, options) => {
      seen.push(options?.hiddenIds);
      return options?.hiddenIds?.has(900) ? { expressId: 1 } : { expressId: 900 };
    };
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm', undefined, (id) => id !== 900);
    assert.equal(await feeder.prepare(0, 0), 'fed');
    assert.deepEqual(h.fed.at(-1)!.map((m) => m.expressId), [1], 'the surface behind the annotation');
    assert.equal(seen.length, 2);
    await registry.close();
  });
});
