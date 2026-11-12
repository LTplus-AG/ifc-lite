/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// W1 (load hillclimb, pre-pixel lane): the cache key from Blob slices, and
// what an early adoption may and may not draw. Adversarial cases first: the
// key decides which entry is looked up, so it must be exactly the key the
// loader derives from the full read; files that differ must not draw each
// other's scene; an edit the sampled key cannot see must still meet the hit
// gate before anything is drawn. Driven through the real renderer Scene on a
// stub GPU device, with the cache service's lookup swapped for a keyed map.
import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import { encodeSceneSnapshot, type Renderer, type RenderPipeline, type SceneSnapshot } from '@ifc-lite/renderer';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { useViewerStore } from '../store/index.js';
import { sceneSnapshotKey } from '../components/viewer/sceneSnapshotOwnership.js';
import { PLACEMENT_IDENTITY_PREFIX } from '../lib/model-placement/source-identity.js';
import { getCacheService, type CacheResult } from '../services/cacheService.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { clearGlobalRefs, setGlobalRendererRef } from './useBCF.js';
import { beginEarlyCacheHit, type EarlyCacheHit } from './earlyCacheHit.js';

(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 };

const MIB = 1024 * 1024;
const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 2, z: 1 } };
const MTIME = 1_700_000_000_000;
const device = {
  limits: { maxBufferSize: 1 << 28 },
  createBuffer: ({ usage }: { usage: number }) => ({ usage, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

/** A STEP file of `size` bytes; `edit` overwrites single bytes. */
function stepFile(size: number, edit: Array<[offset: number, byte: number]> = [], lastModified = MTIME): File {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"), 0);
  for (const [offset, byte] of edit) bytes[offset] = byte;
  return new File([bytes], 'model.ifc', { lastModified });
}

/** The key today's loader derives after the full read (byte length + fingerprint of the bytes read). */
async function fullReadKey(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return buildGeometryCacheKey(bytes.byteLength, computeSourceFingerprint(bytes).hex, false, undefined, true, undefined);
}
const cacheKeyFor = (byteLength: number, hex: string) => buildGeometryCacheKey(byteLength, hex, false, undefined, true, undefined);

function triangle(expressId: number, x: number): MeshData {
  return { expressId, modelIndex: 0, color: [1, 0, 0, 1], positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) } as MeshData;
}
function quantizedScene(): Scene {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}
async function storedSceneBytes(): Promise<ArrayBuffer> {
  const scene = quantizedScene();
  let captured: SceneSnapshot | null = null;
  scene.captureNextFinalize((snapshot) => { captured = snapshot; });
  scene.queueMeshes([triangle(1, 0), triangle(2, 2)]);
  scene.flushPending(device, pipeline, 1000);
  await scene.finalizeStreamingAsync(device, pipeline);
  assert.ok(captured);
  const snapshot = { ...(captured as SceneSnapshot), hostData: { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null, shards: null } };
  return new Response(encodeSceneSnapshot(snapshot)).arrayBuffer();
}
function rendererFor(scene: Scene): Renderer {
  const camera = { reset() {}, fitBoundsAdaptive() {}, setSceneBounds() {}, setOrbitAnchorBounds() {} };
  return { getGPUDevice: () => device, getPipeline: () => pipeline, getScene: () => scene, getCamera: () => camera,
    getCanvas: () => null, clearCaches() {}, requestRender() {}, enableQuantizedBatches: async () => true } as unknown as Renderer;
}

// ─── Harness: a keyed cache, a live renderer around a real Scene ─────────────
const entries = new Map<string, CacheResult>();
const lookedUp: string[] = [];
let realGetCached: ((key: string) => Promise<CacheResult | null>) | null = null;
let scene: Scene;
let rendererRef: { current: Renderer | null };
const savedGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, 'gpu');

/** An entry as a cache write leaves it: stored scene, mtime, full-source identity. */
async function storeEntry(key: string, lastModified = MTIME): Promise<void> {
  const bytes = await storedSceneBytes();
  const { typeViewMode, typeVisibility } = useViewerStore.getState();
  entries.set(key, { buffer: new Blob([new Uint8Array(64)]), lastModified, fullSourceHash: `${PLACEMENT_IDENTITY_PREFIX}stored`,
    sceneSnapshot: { size: bytes.byteLength, arrayBuffer: async () => bytes },
    sceneSnapshotKey: sceneSnapshotKey(scene.sceneSnapshotPolicy(), typeViewMode, typeVisibility) } as unknown as CacheResult);
}

function begin(file: File, isStale = () => false): EarlyCacheHit {
  return beginEarlyCacheHit({ file, modelId: 'm', cacheKeyFor, cachesSize: (n) => n >= 10 * MIB, isStale, trace: NOOP_LOAD_TRACE });
}

beforeEach(async () => {
  const service = await getCacheService();
  realGetCached ??= service.getCached;
  service.getCached = async (key) => { lookedUp.push(key); return entries.get(key) ?? null; };
  entries.clear();
  lookedUp.length = 0;
  Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: {} });
  useViewerStore.setState({ appliedEntityLevelOffsets: new Map() });
  scene = quantizedScene();
  rendererRef = { current: rendererFor(scene) };
  setGlobalRendererRef(rendererRef as never);
});
afterEach(async () => {
  if (realGetCached) (await getCacheService()).getCached = realGetCached;
  clearGlobalRefs();
  if (savedGpu) Object.defineProperty(globalThis.navigator, 'gpu', savedGpu);
  else delete (globalThis.navigator as { gpu?: unknown }).gpu;
});

const SIZE = 12 * MIB;
/** A byte inside the first interior sample window (centred at size/9). */
const IN_WINDOW = Math.floor(SIZE / 9);
/** A byte in the gap between the 64 KiB head and the first interior window. */
const IN_GAP = Math.floor(SIZE / 18);

describe('W1 early cache hit: the key from file slices', () => {
  it('is the key the full read gives, so an entry written before W1 is found and its scene adopted', async () => {
    const file = stepFile(SIZE);
    const key = await fullReadKey(file);
    await storeEntry(key);
    const early = begin(file);
    assert.equal(await early.cacheKey(), key);
    assert.ok(await early.take(), 'the stored scene was not adopted');
    assert.ok(scene.getBatchedMeshes().length > 0);
  });

  it('a same-size file differing inside a sampled window keys another entry: nothing is found or drawn', async () => {
    await storeEntry(await fullReadKey(stepFile(SIZE)));
    const other = stepFile(SIZE, [[IN_WINDOW, 0x41]]);
    const early = begin(other);
    assert.notEqual(await early.cacheKey(), await fullReadKey(stepFile(SIZE)));
    assert.equal(await early.lookup(), null);
    assert.equal(await early.take(), null);
    assert.equal(scene.getBatchedMeshes().length, 0, 'another file\'s scene was drawn');
  });

  it('an edit between sample windows keys the same entry, and a changed mtime refuses it before anything is drawn', async () => {
    const key = await fullReadKey(stepFile(SIZE));
    await storeEntry(key);
    const edited = stepFile(SIZE, [[IN_GAP, 0x41]], MTIME + 1);
    const early = begin(edited);
    assert.equal(await early.cacheKey(), key, 'the sampled key sees the gap edit (then this test no longer probes the gap)');
    assert.ok(await early.lookup(), 'the lookup finds the entry; the hit gate must refuse it');
    assert.equal(await early.take(), null, 'an entry for a changed file was adopted');
    assert.equal(scene.getBatchedMeshes().length, 0);
  });

  it('an mtime-preserving gap edit is drawn like any hit today; the stored full-source identity is what the load revalidates', async () => {
    // Same exposure as before W1: the hit gate passes on a preserved mtime, and the
    // load's background revalidation against `fullSourceHash` purges and reloads
    // (useIfcLoader.sourceHashOnce.test.tsx, "purges and reloads on a content mismatch").
    const key = await fullReadKey(stepFile(SIZE));
    await storeEntry(key);
    const early = begin(stepFile(SIZE, [[IN_GAP, 0x41]]));
    assert.ok(await early.take());
    assert.equal(entries.get(key)?.fullSourceHash?.startsWith(PLACEMENT_IDENTITY_PREFIX), true, 'the entry carries the identity the revalidation needs');
  });

  it('an entry without an mtime or a full-source identity is never drawn early', async () => {
    const key = await fullReadKey(stepFile(SIZE));
    await storeEntry(key, 0);
    const entry = entries.get(key)!;
    entries.set(key, { ...entry, fullSourceHash: undefined });
    const early = begin(stepFile(SIZE, [], 0));
    assert.equal(await early.take(), null);
    assert.equal(scene.getBatchedMeshes().length, 0);
  });
});

describe('W1 early cache hit: ownership', () => {
  it('abandon() withdraws an adopted scene, and take() afterwards gets nothing', async () => {
    const file = stepFile(SIZE);
    await storeEntry(await fullReadKey(file));
    const early = begin(file);
    await early.cacheKey();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(scene.getBatchedMeshes().length > 0, 'precondition: the scene was adopted');
    early.abandon();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scene.getBatchedMeshes().length, 0, 'an abandoned early hit left its scene drawn');
    assert.equal(await early.take(), null);
  });

  it('abandon() before the renderer is up stops the adoption', async () => {
    const file = stepFile(SIZE);
    await storeEntry(await fullReadKey(file));
    rendererRef.current = null; // the viewport is still starting
    let adoptions = 0;
    const adopt = scene.adoptSceneSnapshot.bind(scene);
    scene.adoptSceneSnapshot = (...args) => { adoptions++; return adopt(...args); };
    const early = begin(file);
    await early.lookup();
    early.abandon();
    rendererRef.current = rendererFor(scene);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(adoptions, 0, 'an abandoned adoption still uploaded its scene once the renderer came up');
    assert.equal(scene.getBatchedMeshes().length, 0);
  });

  it('a superseded load adopts nothing', async () => {
    const file = stepFile(SIZE);
    await storeEntry(await fullReadKey(file));
    const early = begin(file, () => true);
    assert.equal(await early.take(), null);
    assert.equal(scene.getBatchedMeshes().length, 0);
  });

  it('a file whose slices cannot be read leaves the lookup to the loader', async () => {
    const file = stepFile(SIZE);
    Object.defineProperty(file, 'slice', { value: () => ({ arrayBuffer: async () => { throw new Error('NotReadableError'); } }) });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const early = begin(file);
      assert.equal(await early.cacheKey(), null);
      early.abandon();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.warn = warn;
    }
    assert.equal(lookedUp.length, 0);
    assert.ok(warnings.some((w) => w.includes('NotReadableError')));
  });
});
