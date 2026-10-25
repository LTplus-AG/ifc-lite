/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { processParallel } from '../../packages/geometry/src/geometry-parallel.js';
import { CoordinateHandler } from '../../packages/geometry/src/coordinate-handler.js';
import { GeometryWorkerPool } from '../../packages/geometry/src/geometry-worker-pool.js';
import { compileSharedWasmModule } from '../../packages/geometry/src/wasm-shared-module.js';
import { decodeInstancedShard } from '../../packages/geometry/src/packed-instanced-decoder.js';
import { FederationRegistry } from '../../packages/renderer/src/federation-registry.js';
import { getWarmGeometryWorkerPool, warmGeometryWorkerPoolStats } from '../../packages/geometry/src/warm-pool.js';
import { scheduleWasmPrewarm } from '../../apps/viewer/src/lib/wasm-prewarm.js';
import { WorkerParser } from '../../packages/parser/src/worker-parser.js';
import type { IfcDataStore } from '../../packages/parser/src/columnar-parser.js';
import type { MeshData } from '../../packages/geometry/src/types.js';
import type { ProcessParallelOptions } from '../../packages/geometry/src/geometry-parallel-options.js';

export interface PoolOutput {
  digest: string;
  meshes: number;
  triangles: number;
  geometryHashes: number;
  ids: number[];
  coordinates: string;
}
export interface PoolReuseReport {
  outputs: Record<string, PoolOutput>;
  spawnedBeforeRepeat: number;
  spawnedAfterRepeat: number;
  finalIdleBytes: number;
  initialWorkerHeapBytes: number[];
  bootWorkerCreations: number;
  bootAdmittedWorkers: number;
  bootWarmingWorkers: number;
  parserHandoffDigest: string;
  parserScanDigest: string;
  federationIdsDistinct: boolean;
}
function hashBytes(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
function hashArray(view: ArrayBufferView): string {
  return hashBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}
const hashText = (text: string) => hashBytes(new TextEncoder().encode(text));

async function load(source: Uint8Array, pool: GeometryWorkerPool | undefined, settings: ProcessParallelOptions): Promise<PoolOutput> {
  const meshes: MeshData[] = [];
  const instances: string[] = [];
  const ids = new Set<number>();
  const hashes: string[] = [];
  const colors = new Map<number, [number, number, number, number]>();
  let triangles = 0, total = -1, geometryHashes = 0, coordinates = '';
  for await (const event of processParallel(source, new CoordinateHandler(), undefined, undefined,
    { workerCountOverride: 1, workerPool: pool, ...settings })) {
    if (event.type === 'colorUpdate') for (const [id, color] of event.updates) colors.set(id, color);
    if (event.type === 'batch') {
      meshes.push(...event.meshes);
      for (const mesh of event.meshes) {
        ids.add(mesh.expressId); triangles += mesh.indices.length / 3;
        if (mesh.geometryHash !== undefined) geometryHashes++;
      }
      for (const bytes of event.instancedShards ?? []) {
        const shard = decodeInstancedShard(bytes);
        for (const instance of shard.instances) {
          ids.add(instance.entityId);
          const template = shard.templates[instance.templateIndex];
          triangles += template.indices.length / 3;
          instances.push(JSON.stringify([instance.entityId, hashArray(template.positions), hashArray(template.normals),
            hashArray(template.indices), template.origin, hashArray(instance.transform), instance.color,
            instance.itemId, instance.metallic, instance.roughness]));
        }
      }
      geometryHashes += event.instancedGeometryHashIds?.length ?? 0;
      for (let i = 0; i < (event.instancedGeometryHashIds?.length ?? 0); i++) {
        hashes.push(`${event.instancedGeometryHashIds?.[i]}:${event.instancedGeometryHashValues?.[i]}`);
      }
    }
    if (event.type === 'complete') { total = event.totalMeshes; coordinates = JSON.stringify(event.coordinateInfo); }
  }
  const records = meshes.map(mesh => JSON.stringify([mesh.expressId, hashArray(mesh.positions), hashArray(mesh.normals),
    hashArray(mesh.indices), colors.get(mesh.expressId) ?? mesh.color, mesh.geometryHash?.toString(), mesh.origin,
    mesh.geometryAabb, mesh.material, mesh.shadingColor]));
  records.push(...instances, ...hashes);
  return { digest: hashText(records.sort().join('\n')), meshes: total, triangles, geometryHashes,
    ids: [...ids].sort((a, b) => a - b), coordinates };
}

function metadataDigest(store: IfcDataStore): string {
  return hashText(JSON.stringify([store.entityCount, [...store.entities.expressId].sort((a, b) => a - b).map(id =>
    [id, store.entities.getTypeName(id), store.entities.getGlobalId(id), store.entities.getName(id)])]));
}

async function bootPool(): Promise<GeometryWorkerPool> {
  const host = globalThis as typeof globalThis & { __IFC_LITE_WARM_POOL?: number };
  host.__IFC_LITE_WARM_POOL = 1;
  const callbacks: IdleRequestCallback[] = [];
  const original = window.requestIdleCallback;
  window.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
  try {
    scheduleWasmPrewarm(); scheduleWasmPrewarm();
    if (callbacks.length !== 1) throw new Error('Idle engine prewarm was not scheduled exactly once');
    callbacks[0]({ didTimeout: false, timeRemaining: () => 50 });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const pool = getWarmGeometryWorkerPool();
      if (pool?.stats().idle === 2) return pool;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Idle boot did not create its bounded geometry/pre-pass instances');
  } finally { window.requestIdleCallback = original; }
}

/** Actual authoring-tool IFCs, real worker FIFO and real WASM; elapsed time is deliberately not a verdict. */
export async function runPoolReuseWitness(sourceUrls: [string, string]): Promise<PoolReuseReport> {
  const sources = await Promise.all(sourceUrls.map(async url => {
    const response = await fetch(url); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const pool = await bootPool();
  const bootWorkerCreations = pool.stats().spawned;
  const bootAdmittedWorkers = pool.stats().prewarmed;
  const bootWarmingWorkers = pool.stats().warming;
  const initialWorkerHeapBytes: number[] = [];
  // Inspect real reset acknowledgements from the actual boot-created instances.
  await Promise.all(['geometry', 'prepass'].map(async role => {
    const lease = pool.acquire(role as 'geometry' | 'prepass', '');
    const messages: unknown[] = [];
    const record = ({ data }: MessageEvent<{ type?: string; wasmHeapBytes?: number }>) => {
      messages.push(data);
      if (data.type === 'pool-reset-done' && data.wasmHeapBytes !== undefined) initialWorkerHeapBytes.push(data.wasmHeapBytes);
    };
    lease.worker.addEventListener('message', record);
    try {
      if (!await pool.release(lease.worker)) throw new Error(`Boot-created worker could not reset: ${JSON.stringify(messages)}`);
    }
    finally { lease.worker.removeEventListener('message', record); }
  }));
  const module = await compileSharedWasmModule();
  if (!module) throw new Error('Real compiled IFC engine unavailable');
  const parser = new WorkerParser();
  const sab = new SharedArrayBuffer(sources[0].byteLength); new Uint8Array(sab).set(sources[0]);
  let parserError: unknown;
  const handedOff = parser.parseColumnar(sab, { waitForEntityIndex: true,
    wasmModulePromise: new Promise<WebAssembly.Module | null>(() => {}) }).catch(error => { parserError = error; return null; });
  const outputs: Record<string, PoolOutput> = {};
  try {
    outputs.first = await load(sources[0], pool, { onEntityIndex: (...columns) => parser.setEntityIndex(...columns) });
    const handedOffStore = await handedOff;
    if (!handedOffStore) throw parserError;
    const parserHandoffDigest = metadataDigest(handedOffStore);
    const freshParser = new WorkerParser();
    let scannedStore: IfcDataStore;
    try { scannedStore = await freshParser.parseColumnar(sab, { wasmModulePromise: Promise.resolve(module) }); }
    finally { freshParser.terminate(); }
    const parserScanDigest = metadataDigest(scannedStore);
    const spawnedBeforeRepeat = pool.stats().spawned;
    outputs.repeat = await load(sources[0], pool, {});
    const spawnedAfterRepeat = pool.stats().spawned;
    const federationSettings: ProcessParallelOptions = { enableInstancing: false, mergeLayers: true,
      tessellationQuality: 'lowest', skipSmallCuts: true, geometryHashTolerance: 0.001 };
    outputs.federated = await load(sources[1], pool, federationSettings);
    outputs.federatedFresh = await load(sources[1], undefined, federationSettings);
    outputs.restored = await load(sources[0], pool, {});
    outputs.restoredFresh = await load(sources[0], undefined, {});
    const registry = new FederationRegistry();
    registry.registerModel('primary', Math.max(...outputs.first.ids));
    const primaryIds = new Set(outputs.first.ids.map(id => registry.toGlobalId('primary', id)));
    registry.registerModel('federated', Math.max(...outputs.federated.ids));
    const federationIdsDistinct = outputs.federated.ids.every(id => !primaryIds.has(registry.toGlobalId('federated', id)));
    return { outputs, spawnedBeforeRepeat, spawnedAfterRepeat, initialWorkerHeapBytes, bootWorkerCreations, bootAdmittedWorkers, bootWarmingWorkers, parserHandoffDigest, parserScanDigest, finalIdleBytes: pool.stats().idleBytes, federationIdsDistinct };
  } finally { parser.terminate(); pool.drain('witness-end'); }
}

/** The document starts hidden before pool hooks exist; no visibility event is dispatched. */
export async function runHiddenBootAdmissionWitness(): Promise<{ idle: number; spawned: number }> {
  const host = globalThis as typeof globalThis & { __IFC_LITE_WARM_POOL?: number };
  host.__IFC_LITE_WARM_POOL = 1;
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  const original = window.requestIdleCallback;
  const callbacks: IdleRequestCallback[] = [];
  window.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
  try {
    scheduleWasmPrewarm();
    if (callbacks.length !== 1) throw new Error('Hidden admission control was not scheduled');
    callbacks[0]({ didTimeout: false, timeRemaining: () => 50 });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const stats = warmGeometryWorkerPoolStats();
      if (stats) { await new Promise(resolve => setTimeout(resolve, 0)); return warmGeometryWorkerPoolStats() ?? stats; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Hidden admission control did not reach the canonical pool');
  } finally {
    window.requestIdleCallback = original;
    Reflect.deleteProperty(document, 'hidden');
    getWarmGeometryWorkerPool()?.drain('hidden-witness-end');
  }
}
