/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live-geometry backing in a REAL browser: Chromium's IndexedDB structured
 * clone, quota enforcement, connection lifecycle and Web Locks, against the
 * viewer's own module source served by a private Vite dev server. The node
 * suite (`geometry-backing.test.ts`) covers the same contract on fake-indexeddb;
 * this spec is the browser proof. Release of CPU geometry stays disabled.
 */

import { type Page } from '@playwright/test';
import { test, expect } from './gpu-browser';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

type Registry = typeof import('../../apps/viewer/src/lib/geometry-backing/geometry-backing-registry');
type Fixtures = typeof import('../../apps/viewer/src/lib/geometry-backing/geometry-backing.test-fixtures');
type Geometry = typeof import('../../packages/geometry/src/index');
declare global {
  // eslint-disable-next-line no-var
  var __backingSpec__: { registry?: InstanceType<Registry['GeometryBackingRegistry']> } | undefined;
}

let server: ViewerDevServer;
test.beforeAll(async () => {
  // Every case navigates to a static document, so skip Vite's viewer entry scan.
  server = await startViewerDevServer('geometry-backing', { scanViewerEntries: false });
});
test.afterAll(async () => { await server?.close(); });

const REGISTRY = '/src/lib/geometry-backing/geometry-backing-registry.ts';
const FIXTURES = '/src/lib/geometry-backing/geometry-backing.test-fixtures.ts';
const GEOMETRY = `/@fs/${fileURLToPath(new URL('../../packages/geometry/src/index.ts', import.meta.url))}`;

/** A same-origin document that does not boot the viewer app. */
async function staticPage(page: Page): Promise<void> {
  await page.goto(new URL('samples/demo-kit.json', server.url).href);
}

test('real IndexedDB round-trips every mesh field, ImageBitmap re-attachment and instanced shards', async ({ page }) => {
  await staticPage(page);
  const result = await page.evaluate(async ([registryPath, fixturesPath]) => {
    const { GeometryBackingRegistry } = await import(registryPath) as Registry;
    const { fullMesh, instancedShard, describeMesh } = await import(fixturesPath) as Fixtures;
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray([9, 8, 7, 255]), 1, 1));
    const registry = await GeometryBackingRegistry.open({ name: 'geometry-backing-spec-fidelity' });
    const backing = await registry.begin('model', { chunkBytes: 64, queueBytes: 4096 });
    const shared = Uint32Array.from([0, 1, 2, 2, 1, 0]);
    const meshes = [fullMesh(10, shared, bitmap), fullMesh(20, shared, bitmap)];
    const shard = instancedShard();
    await backing.writer.append(meshes);
    await backing.writer.appendInstancedShard(shard);
    await backing.writer.close();
    const read = [];
    for await (const batch of backing.reader.meshes()) read.push(...batch);
    const shards = [];
    for await (const record of backing.reader.instancedShards()) shards.push(record);
    const text = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? `bigint:${v}` : v);
    const out = {
      complete: backing.isComplete, sweeps: registry.sweepsStaleSessions,
      chunks: backing.directory.chunks.length,
      same: text(read.map(describeMesh)) === text(meshes.map(describeMesh)),
      bigint: typeof read[0].geometryHash,
      fence: read[0].appearanceSource?.indices === read[0].indices,
      sharedSource: read[0].appearanceSource?.sourceIndices === read[1].appearanceSource?.sourceIndices,
      bitmap: read[0].textureBitmap === bitmap,
      exactBuffer: read[0].positions.buffer.byteLength,
      shard: text(shards) === text([shard]),
    };
    await registry.close();
    return out;
  }, [REGISTRY, FIXTURES]);
  expect(result).toEqual({ complete: true, sweeps: true, chunks: 2, same: true, bigint: 'bigint', fence: true,
    sharedSource: true, bitmap: true, exactBuffer: 36, shard: true });
});

test('a real quota refusal fails the backing terminally and is never replayed', async ({ page }) => {
  await staticPage(page);
  const cdp = await page.context().newCDPSession(page);
  const origin = new URL(server.url).origin;
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 4 * 1024 * 1024 });
  try {
    const result = await page.evaluate(async (registryPath) => {
      const { GeometryBackingRegistry } = await import(registryPath) as Registry;
      const registry = await GeometryBackingRegistry.open({ name: 'geometry-backing-spec-quota' });
      const backing = await registry.begin('model', { chunkBytes: 1 << 20, queueBytes: 8 << 20 });
      // Chromium compresses IndexedDB values: only incompressible bytes reach the quota.
      const noise = () => new Float32Array(new Uint32Array(1 << 18).map(() => (Math.random() * 0x3f000000) >>> 0).buffer);
      const mesh = (id: number) => ({ expressId: id, positions: noise(),
        normals: new Float32Array(1 << 18), indices: new Uint32Array(3), color: [1, 1, 1, 1] as [number, number, number, number] });
      let error: unknown;
      try {
        for (let id = 1; id <= 24; id++) await backing.writer.append([mesh(id)]);
        await backing.writer.close();
      } catch (caught) { error = caught; }
      const failure = error as Error & { cause?: Error };
      const states = backing.directory.chunks.map((chunk) => chunk.state);
      const later = await backing.writer.append([mesh(99)]).then(() => 'accepted', (e: Error) => e.name);
      const out = { name: failure?.name, cause: failure?.cause?.name, complete: backing.isComplete,
        durable: states.filter((s) => s === 'durable').length, failed: states.filter((s) => s === 'failed').length,
        pending: states.filter((s) => s === 'pending').length, later };
      await registry.close();
      return out;
    }, REGISTRY);
    expect(result.name).toBe('GeometryBackingFailedError');
    expect(result.cause).toBe('QuotaExceededError');
    expect(result.complete).toBe(false);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.pending).toBe(0);
    expect(result.later).toBe('GeometryBackingFailedError');
  } finally {
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  }
});

test('a closed connection reopens once; replacement fences and deletes the old generation', async ({ page }) => {
  await staticPage(page);
  const result = await page.evaluate(async (registryPath) => {
    const { GeometryBackingRegistry } = await import(registryPath) as Registry;
    const registry = await GeometryBackingRegistry.open({ name: 'geometry-backing-spec-lifecycle' });
    const mesh = (id: number) => ({ expressId: id, positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, id]),
      normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] as [number, number, number, number] });
    const first = await registry.begin('model');
    (registry as unknown as { db: { connection: IDBDatabase } }).db.connection.close();
    await first.writer.append([mesh(1)]);
    await first.writer.close();
    const lease = await first.reader.leaseEntity(1);
    const firstZ = lease.meshes[0].positions[8];
    lease.release();
    const second = await registry.begin('model');
    const stale = await first.reader.leaseEntity(1).then(() => 'read', (e: Error) => e.name);
    await second.writer.append([mesh(2)]);
    await second.writer.close();
    const fresh = await second.reader.leaseEntity(2);
    const out = { firstZ, stale, secondZ: fresh.meshes[0].positions[8], generation: second.generation,
      firstComplete: first.isComplete, secondComplete: second.isComplete };
    fresh.release();
    // Count the old generation's records through a raw connection.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('geometry-backing-spec-lifecycle');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const tx = raw.transaction('chunks');
      const request = tx.objectStore('chunks').count(IDBKeyRange.bound(
        [registry.session, first.backingId], [registry.session, first.backingId, []]));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    raw.close();
    await registry.close();
    return { ...out, oldRecords: count };
  }, REGISTRY);
  expect(result).toEqual({ firstZ: 1, stale: 'StaleGeometryGenerationError', secondZ: 2, generation: 2,
    firstComplete: false, secondComplete: true, oldRecords: 0 });
});

test('a closed page releases its Web Lock and the next page sweeps its geometry; live pages are spared', async ({ context }) => {
  const write = async (page: Page) => {
    await staticPage(page);
    return page.evaluate(async (registryPath) => {
      const { GeometryBackingRegistry } = await import(registryPath) as Registry;
      const registry = await GeometryBackingRegistry.open({ name: 'geometry-backing-spec-sweep' });
      const backing = await registry.begin('model');
      await backing.writer.append([{ expressId: 1, positions: new Float32Array(9), normals: new Float32Array(9),
        indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] }]);
      await backing.writer.close();
      globalThis.__backingSpec__ = { registry };
      return registry.session;
    }, REGISTRY);
  };
  const closing = await context.newPage();
  const live = await context.newPage();
  const closedSession = await write(closing);
  const liveSession = await write(live);
  await closing.close();
  const third = await context.newPage();
  const thirdSession = await write(third);
  const sessions = await third.evaluate(async () => {
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('geometry-backing-spec-sweep');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = raw.transaction('sessions').objectStore('sessions').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    raw.close();
    return keys;
  });
  expect(new Set(sessions)).toEqual(new Set([liveSession, thirdSession]));
  expect(sessions).not.toContain(closedSession);
  for (const page of [live, third]) {
    await page.evaluate(async () => { await globalThis.__backingSpec__?.registry?.close(); });
    await page.close();
  }
});

test('public IFC models: every streamed mesh reads back field-for-field from real IndexedDB', async ({ page }, info) => {
  // #11070: the backing round trip only needs real WASM meshes. Booting the
  // viewer here also loaded its dev-server module graph, renderer and store.
  await staticPage(page);
  const rows = [];
  for (const sample of ['building-architecture.ifc', 'infra-bridge.ifc']) {
    const row = await page.evaluate(async ([registryPath, geometryPath, name]) => {
      const { GeometryBackingRegistry } = await import(registryPath) as Registry;
      const { GeometryProcessor } = await import(geometryPath) as Geometry;

      // Compare typed-array views in place. The backing strips unused arena
      // bytes and omits undefined fields when it writes a record.
      const equal = (left: unknown, right: unknown): boolean => {
        if (Object.is(left, right)) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        if (ArrayBuffer.isView(left)) {
          if (!ArrayBuffer.isView(right) || left.constructor !== right.constructor ||
              left.byteLength !== right.byteLength) return false;
          const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
          const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
          return a.every((byte, index) => byte === b[index]);
        }
        if (Array.isArray(left) && Array.isArray(right)) {
          return left.length === right.length && left.every((value, index) => equal(value, right[index]));
        }
        if (Object.getPrototypeOf(left) !== Object.prototype ||
            Object.getPrototypeOf(right) !== Object.prototype) return false;
        const a = left as Record<string, unknown>;
        const b = right as Record<string, unknown>;
        return Object.keys(a).every((key) => equal(a[key], b[key])) &&
          Object.keys(b).every((key) => Object.hasOwn(a, key) || b[key] === undefined);
      };
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error(`Could not fetch ${name} (HTTP ${response.status})`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const registry = await GeometryBackingRegistry.open({ name: `geometry-backing-spec-${name}` });
      const processor = new GeometryProcessor();
      try {
        const backing = await registry.begin(name, { chunkBytes: 1 << 20, queueBytes: 8 << 20, decodedCacheBytes: 0 });
        let meshes = 0, read = 0, mismatches = 0, fences = 0, readFences = 0, peak = 0;
        let withAppearance = 0, withEntityIds = 0, completedMeshCount: number | undefined;
        let chunkIndex = 0;
        for await (const event of processor.processStreaming(buffer)) {
          if (event.type === 'complete') completedMeshCount = event.totalMeshes;
          if (event.type !== 'batch') continue;

          // Flush and verify each producer batch before advancing the stream.
          await backing.writer.append(event.meshes);
          await backing.writer.flush();
          meshes += event.meshes.length;
          let batchRead = 0;
          for (; chunkIndex < backing.directory.chunks.length; chunkIndex++) {
            const lease = await backing.reader.leaseChunks([chunkIndex]);
            try {
              peak = Math.max(peak, backing.reader.retainedBytes);
              for (const mesh of lease.meshes) {
                const original = event.meshes[batchRead++];
                const readFence = mesh.appearanceSource?.indices === mesh.indices;
                const fence = original !== undefined && original.appearanceSource?.indices === original.indices;
                if (!equal(original, mesh) || readFence !== fence) mismatches++;
                if (readFence) readFences++;
                if (fence) fences++;
                if (original?.appearanceSource) withAppearance++;
                if (original?.entityIds) withEntityIds++;
              }
            } finally {
              lease.release();
            }
          }
          if (batchRead !== event.meshes.length) {
            throw new Error(`${name}: wrote ${event.meshes.length} meshes in batch, read ${batchRead}`);
          }
          read += batchRead;
        }
        await backing.writer.close();
        const storedBytes = backing.directory.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
        return { name, meshes, read, completedMeshCount, mismatches, fences, readFences,
          chunks: chunkIndex, storedBytes, peakDecodedBytes: peak, retainedDecodedBytes: backing.reader.retainedBytes,
          withAppearance, withEntityIds, complete: backing.isComplete };
      } finally {
        processor.dispose();
        await registry.close();
      }
    }, [REGISTRY, GEOMETRY, sample] as const);
    rows.push(row);
    expect(row.meshes, sample).toBeGreaterThan(0);
    expect(row.read, sample).toBe(row.meshes);
    expect(row.completedMeshCount, sample).toBe(row.meshes);
    expect(row.mismatches, sample).toBe(0);
    expect(row.readFences, sample).toBe(row.fences);
    expect(row.retainedDecodedBytes, sample).toBe(0);
    expect(row.complete, sample).toBe(true);
  }
  await writeFile(info.outputPath('geometry-backing-public-models.json'), JSON.stringify(rows, null, 2));
});
