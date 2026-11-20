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
import { readInstancedOccurrences } from './instanced-readback';
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
    getModelRotation: () => null,
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

  it('a placement that throws releases the leases it took and feeds nothing', async () => {
    const { registry, backing } = await backed([mesh(1, 0), mesh(2, 0.5)]);
    const h = host({ released: true, hit: { expressId: 1, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } });
    const scene = h.value.getScene() as { placeAppearanceSource: (m: MeshData) => MeshData };
    // The offset probe (expressId 0) still places; the first real piece fails, after every lease was taken.
    const placeFirst = scene.placeAppearanceSource;
    scene.placeAppearanceSource = (m: MeshData) => {
      if (m.expressId === 0) return placeFirst(m);
      throw new Error('placement failed');
    };
    // Count the leases the feeder takes and gives back.
    let open = 0;
    const reader = backing.reader as unknown as Record<'leaseEntity' | 'leaseChunks', (...args: unknown[]) => Promise<{ release: () => void }>>;
    for (const name of ['leaseEntity', 'leaseChunks'] as const) {
      const real = reader[name].bind(reader);
      reader[name] = async (...args) => {
        const lease = await real(...args);
        open++;
        const release = lease.release.bind(lease);
        return { ...lease, release: () => { open--; release(); } };
      };
    }
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(10, 10), 'unavailable');
    assert.equal(h.fed.at(-1) ?? null, null, 'nothing was fed');
    assert.equal(open, 0, 'every lease taken before the failed placement was released');
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

  it('#10903 instancing lost but flat records whole: flat-only readback answers where the scene shows no instanced occurrence, and only there', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const open = await registry.begin('m'); // not complete: its instancing was lost, so it is never acknowledged
    await open.writer.append([mesh(1, 0), mesh(2, 0.5)]);
    await open.writer.flush(); // every flat record sealed and durable, the writer still open
    const flat = { backing: () => open, flatComplete: () => true };
    const state = { released: true, hit: { expressId: 1, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } };
    const clear = host(state);
    const feeder = new ReadbackRaycastFeeder(clear.value, () => flat, () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'not fed');
    assert.deepEqual(clear.fed.at(-1)!.map((m) => m.expressId).sort(), [1, 2], 'the same flat neighbourhood a complete backing feeds');
    // A (lost) instanced occurrence in the region: its surface could be in front or a snap target.
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const crowded = host(state, new Map([[700, near]]));
    const refused = new ReadbackRaycastFeeder(crowded.value, () => flat, () => 'm');
    assert.equal(await refused.prepare(0, 0), 'unavailable', 'never answered without the lost occurrence');
    assert.match(refused.lastError!.message, /instanced occurrences whose backing was lost/);
    // An instanced hit itself is never answered flat-only.
    const instancedHit = host({ released: true, hit: { expressId: 700, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, new Map([[700, near]]));
    assert.equal(await new ReadbackRaycastFeeder(instancedHit.value, () => flat, () => 'm').prepare(0, 0), 'unavailable');
    // Without the flat proof, the incomplete generation answers nothing.
    assert.equal(await new ReadbackRaycastFeeder(clear.value, () => ({ backing: () => open }), () => 'm').prepare(0, 0), 'unavailable');
    await open.writer.close();
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
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'instanced geometry should be fed');
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

  it('#10884 more instanced neighbours than the cap is refused, never silently truncated', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard());
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const crowd = new Map<number, Box>([[501, near]]);
    for (let id = 1000; id < 1300; id++) crowd.set(id, near); // 300 neighbours inside the box
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, crowd);
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable', 'a truncated neighbourhood could snap differently');
    assert.match(feeder.lastError!.message, /instanced neighbours/);
    await registry.close();
  });

  it('#10884 an instanced readback bound that is not a byte count (NaN, negative) fails instead of passing any size', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard());
    await backing.writer.close();
    for (const budgetBytes of [Number.NaN, -1]) {
      await assert.rejects(readInstancedOccurrences(backing, new Set([501]), 0, { budgetBytes }), GeometryUnavailableError);
    }
    await registry.close();
  });

  it('#10884 exactly the cap of instanced neighbours, the picked one yielded last, is fed, not refused', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard());
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const box = new Map<number, Box>();
    for (let id = 1000; id < 1255; id++) box.set(id, near); // 255 others ...
    box.set(501, near); // ... and the picked one last: 256 distinct ids
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, box);
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'not fed');
    await registry.close();
  });

  it('#10884 an instanced hit without a model index is refused, never materialized as model 0', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard());
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const h = host({ released: true, hit: { expressId: 501, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, new Map([[501, near]]));
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable', 'its occurrences would be placed in the wrong frame');
    assert.match(feeder.lastError!.message, /no model index/);
    assert.equal(h.fed.at(-1), null);
    await registry.close();
  });

  it('#10884 hidden instanced neighbours neither count toward the cap nor are fed', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard());
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const crowd = new Map<number, Box>([[501, near]]);
    const hidden = new Set<number>();
    for (let id = 1000; id < 1300; id++) { crowd.set(id, near); hidden.add(id); } // 300 hidden neighbours inside the box
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, crowd);
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0, { hiddenIds: hidden }), 'fed', feeder.lastError?.message ?? 'not fed');
    assert.equal(await feeder.prepare(0, 0, { isolatedIds: new Set([501]) }), 'fed', 'isolation leaves the others out too');
    await registry.close();
  });

  it('#10884 an instanced occurrence whose placement throws releases the flat leases too and feeds nothing', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard()); // 501 opaque
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, new Map([[501, near]]));
    const scene = h.value.getScene() as { placeAppearanceSource: (m: MeshData) => MeshData };
    const placeFlat = scene.placeAppearanceSource;
    scene.placeAppearanceSource = (m: MeshData) => {
      if (m.occurrenceKey?.startsWith('readback:')) throw new Error('occurrence placement failed');
      return placeFlat(m);
    };
    let open = 0;
    const reader = backing.reader as unknown as Record<'leaseEntity' | 'leaseChunks', (...args: unknown[]) => Promise<{ release: () => void }>>;
    for (const name of ['leaseEntity', 'leaseChunks'] as const) {
      const real = reader[name].bind(reader);
      reader[name] = async (...args) => {
        const lease = await real(...args);
        open++;
        const release = lease.release.bind(lease);
        return { ...lease, release: () => { open--; release(); } };
      };
    }
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm');
    assert.equal(await feeder.prepare(0, 0), 'unavailable');
    assert.equal(h.fed.at(-1) ?? null, null, 'nothing was fed');
    assert.equal(open, 0, 'the flat leases taken before the failed occurrence placement were released');
    await registry.close();
  });

  it('#10880 r4646577967 an empty store list reads a current complete backing, and yields nothing without one', async () => {
    const { registry, backing } = await backed([mesh(1, 0), mesh(2, 3)]);
    const batches: Array<readonly MeshData[]> = [];
    for await (const batch of modelGeometry({ backing: () => backing }, 'm', [])) batches.push(batch);
    assert.deepEqual(batches.flat().map((m) => m.expressId).sort(), [1, 2], 'the backed meshes, never one empty batch');
    const none: Array<readonly MeshData[]> = [];
    for await (const batch of modelGeometry({ backing: () => undefined }, 'm', [])) none.push(batch);
    assert.deepEqual(none, [], 'an unbacked empty model yields nothing and does not fail');
  });

  it('#10884 r4648098405 a flat overlay neighbour (a backed annotation beside the hit) is not fed', async () => {
    const { registry, backing } = await backed([mesh(1, 0), mesh(900, 0.5)]); // 900: an IfcAnnotation over the wall
    const h = host({ released: true, hit: { expressId: 1, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } });
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm', undefined, (id) => id !== 900);
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'not fed');
    assert.deepEqual(h.fed.at(-1)!.map((m) => m.expressId), [1], 'the overlay is never a raycast or snap target, as in the resident scene');
    await registry.close();
  });

  it('#10884 an instanced overlay neighbour (an annotation the resident raycast never tests) is not fed', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const backing = await registry.begin('m');
    await backing.writer.append([mesh(1, 0)]);
    await backing.writer.appendInstancedShard(instancedShard()); // 501 opaque
    const overlay = instancedShard();
    overlay.instances = [{ ...overlay.instances[0], entityId: 503 }]; // an instanced IfcAnnotation beside the hit
    await backing.writer.appendInstancedShard(overlay);
    await backing.writer.close();
    const near = { min: { x: 99, y: -1, z: 4 }, max: { x: 101, y: 1, z: 6 } };
    const h = host({ released: true, hit: { expressId: 501, modelIndex: 0, worldXYZ: { x: 100.2, y: 0.2, z: 5 } } }, new Map([[501, near], [503, near]]));
    const feeder = new ReadbackRaycastFeeder(h.value, () => ({ backing: () => backing }), () => 'm', undefined, (id) => id !== 503);
    assert.equal(await feeder.prepare(0, 0), 'fed', feeder.lastError?.message ?? 'not fed');
    const instanced = h.fed.at(-1)!.filter((m) => m.occurrenceKey?.startsWith('readback:'));
    assert.deepEqual(instanced.map((m) => m.expressId), [501], 'the overlay is never a raycast target, as in the resident scene');
    await registry.close();
  });
});
