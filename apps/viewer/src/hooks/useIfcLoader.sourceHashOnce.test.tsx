/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7022: one full-source hash per load, and none of it in front of first paint.
 *
 * The loader used to await the placement identity (a full-file SHA-256 in
 * 1 MiB chunks) before the cache lookup, engine init and geometry, then hash
 * the same bytes again for the cache write or for a warm hit's background
 * revalidation. Now the identity starts as soon as the bytes are in hand and
 * runs beside the load; the cache write stores it and the revalidation
 * compares against it. These tests drive the real hook:
 *
 * - geometry is published while the hash is still pending, and the model only
 *   completes once its identity is on the record;
 * - a hash that settles after a newer load started writes nothing;
 * - a warm hit hashes the source once, still purges and reloads on a content
 *   mismatch, and never serves an entry whose stored hash it cannot compare.
 *
 * `crypto.subtle.digest` is wrapped (a property swap, never `mock.module`) to
 * count the source bytes digested and, where a test needs it, to hold every
 * digest until released. Expected identities come from node:crypto, not from
 * the viewer's own hashing, so a hashing bug cannot certify itself.
 * Cache-hit harness: the one `useIfcLoader.cacheHitTelemetry.test.tsx` uses.
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StringTable, EntityTableBuilder, PropertyTableBuilder, QuantityTableBuilder, RelationshipGraphBuilder } from '@ifc-lite/data';
import { BinaryCacheWriter, computeSourceFingerprint, type CacheDataStore } from '@ifc-lite/cache';
import { perfCounters } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import { CACHE_SIZE_THRESHOLD } from '@/utils/ifcConfig.js';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { getCached, setCached } from '../services/cacheService.js';
import { useIfcLoader } from './useIfcLoader.js';
import { hasPersistedMarkupEntryFor, useDrawing2DPersistence } from './useDrawing2DPersistence.js';

const MIB = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** The placement identity's construction, computed independently. */
function referenceIdentity(bytes: Uint8Array): string {
  const parts = [`placement-sha256-1m-v1:${bytes.byteLength}`];
  for (let start = 0; start < bytes.byteLength; start += MIB) parts.push(sha256(bytes.subarray(start, start + MIB)));
  return `placement-sha256-1m-v1:${sha256(parts.join(':'))}`;
}

// ─── crypto.subtle.digest seam ───────────────────────────────────────────────
const subtle = globalThis.crypto.subtle;
const realDigest = subtle.digest.bind(subtle);
let sourceBytesDigested = 0;
let holdDigests = false;
let held: Array<() => void> = [];
function installDigestSpy(): void {
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    writable: true,
    value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      // Chunk digests and whole-buffer digests; the small digest over the
      // joined chunk hashes is metadata, not a pass over the source.
      if (data.byteLength >= 4096) sourceBytesDigested += data.byteLength;
      const copy = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        : new Uint8Array(data).slice();
      if (!holdDigests) return realDigest(algorithm, copy);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        held.push(() => { realDigest(algorithm, copy).then(resolve, reject); });
      });
    },
  });
}
function releaseDigests(): void {
  holdDigests = false;
  const pending = held;
  held = [];
  for (const run of pending) run();
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
function stepBytes(targetBytes: number, fill = 0x20): Uint8Array {
  const header = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n");
  const footer = new TextEncoder().encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const bytes = new Uint8Array(targetBytes);
  bytes.set(header, 0);
  bytes.fill(fill, header.length, targetBytes - footer.length);
  bytes.set(footer, targetBytes - footer.length);
  return bytes;
}

function glbBytes(expressId: number): Uint8Array {
  const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer.byteLength + 12);
  bin.set(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer), 0);
  bin.set(new Uint8Array(new Uint32Array([0, 1, 2]).buffer), 72);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { expressId } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.7, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, byteStride: 12, target: 34962 },
      { buffer: 0, byteOffset: 72, byteLength: 12, target: 34963 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  }));
  const jsonLen = Math.ceil(json.byteLength / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLen + 8 + bin.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen); out.set(json, 20);
  view.setUint32(20 + jsonLen, bin.byteLength, true); view.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(bin, 28 + jsonLen);
  return out;
}

function cacheDataStore(): CacheDataStore {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(2, strings);
  entities.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
  return {
    schema: 1, entityCount: 1, strings, entities: entities.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

/** The key `loadFile` derives, from the same helpers and store fields. */
function cacheKeyFor(buffer: ArrayBuffer): string {
  const state = useViewerStore.getState();
  return buildGeometryCacheKey(buffer.byteLength, computeSourceFingerprint(buffer).hex, state.mergeLayers, undefined,
    state.geometryMode === 'fast', resolveLoadTessellationTier(buffer.byteLength / MIB, state.geometryMode));
}

/** `setCached` wraps the payload in a Blob that fake-indexeddb cannot clone;
 *  store the same bytes as a plain ArrayBuffer (see cacheHitTelemetry test). */
async function storePayloadAsArrayBuffer(key: string, payload: ArrayBuffer): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('ifc-lite-cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('models', 'readwrite');
    const store = tx.objectStore('models');
    const get = store.get(key);
    get.onsuccess = () => store.put({ ...(get.result as Record<string, unknown>), buffer: payload });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Seed a source-tier entry for `file` carrying `fullSourceHash`; returns its key. */
async function seedCacheEntry(file: File, fullSourceHash: string): Promise<string> {
  const buffer = await file.arrayBuffer();
  const payload = await new BinaryCacheWriter().write(cacheDataStore(), undefined, buffer,
    { includeGeometry: false, omitSourceHash: true }) as ArrayBuffer;
  const key = cacheKeyFor(buffer);
  await setCached(key, payload, file.name, buffer.byteLength, buffer, { lastModified: file.lastModified, fullSourceHash });
  await storePayloadAsArrayBuffer(key, payload);
  return key;
}

/** Let fire-and-forget work (revalidation, a reload it starts) settle. */
async function settle(ms = 400): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${label}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────
let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let progressPhases: string[] = [];
const realSetProgress = useViewerStore.getState().setProgress;

beforeEach(async () => {
  hookApi = null;
  sourceBytesDigested = 0;
  holdDigests = false;
  held = [];
  progressPhases = [];
  installDigestSpy();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ setProgress: (p) => { if (p?.phase) progressPhases.push(p.phase); return realSetProgress(p); } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  releaseDigests();
  useViewerStore.setState({ setProgress: realSetProgress });
  delete (subtle as { digest?: unknown }).digest;
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

const onlyModel = () => [...useViewerStore.getState().models.values()][0];

describe('useIfcLoader — the full-source hash runs beside the load, not in front of it (#7022)', () => {
  it('publishes geometry while the hash is pending, and completes the model only with its identity', async () => {
    const bytes = glbBytes(7);
    const file = new File([bytes as BlobPart], 'pending-hash.glb', { type: 'model/gltf-binary' });
    holdDigests = true;
    let loading!: Promise<void>;
    await act(async () => { loading = hookApi!.loadFile(file); });
    await waitFor(() => (useViewerStore.getState().geometryResult?.meshes.length ?? 0) > 0,
      'the GLB geometry to reach the store while every digest is held');
    assert.ok(held.length > 0, 'the identity hash is still in flight when geometry is published');
    assert.notEqual(onlyModel()?.loadState, 'complete', 'the model does not complete before its identity is known');
    assert.equal(onlyModel()?.sourceContentHash, undefined);
    releaseDigests();
    await act(async () => { await loading; });
    assert.equal(onlyModel()?.loadState, 'complete');
    assert.equal(onlyModel()?.sourceContentHash, referenceIdentity(bytes), 'the identity value is unchanged');
  });

  it('a hash that settles after a newer load started writes nothing', async () => {
    const older = glbBytes(1), newer = glbBytes(2);
    const seen = new Set<string>();
    const unsubscribe = useViewerStore.subscribe((state) => {
      for (const model of state.models.values()) if (model.sourceContentHash) seen.add(model.sourceContentHash);
    });
    try {
      holdDigests = true;
      let first!: Promise<void>, second!: Promise<void>;
      await act(async () => { first = hookApi!.loadFile(new File([older as BlobPart], 'older.glb')); });
      await waitFor(() => held.length > 0, 'the older load to start hashing');
      await act(async () => { second = hookApi!.loadFile(new File([newer as BlobPart], 'newer.glb')); });
      releaseDigests();
      await act(async () => { await Promise.allSettled([first, second]); });
      await settle(100);
      assert.ok(!seen.has(referenceIdentity(older)), 'the superseded load never wrote its identity');
      assert.equal(useViewerStore.getState().models.size, 1);
      assert.equal(onlyModel()?.name, 'newer.glb');
      assert.equal(onlyModel()?.sourceContentHash, referenceIdentity(newer));
    } finally {
      unsubscribe();
    }
  });

  it('counts exactly one full-source hash pass for a load', async () => {
    perfCounters.enable(); // what `?perfTrace=1` and the benchmark do; this file's process only
    const before = perfCounters.read()['hash.fullSource.count'] ?? 0;
    await act(async () => { await hookApi!.loadFile(new File([glbBytes(3) as BlobPart], 'counted.glb')); });
    assert.equal((perfCounters.read()['hash.fullSource.count'] ?? 0) - before, 1);
  });
});

describe('useIfcLoader — a warm hit validates against the load\'s one hash (#7022)', () => {
  it('serves a matching entry and digests the source once', async () => {
    const bytes = stepBytes(CACHE_SIZE_THRESHOLD + 4096);
    const file = new File([bytes as BlobPart], 'warm-match.ifc');
    const key = await seedCacheEntry(file, referenceIdentity(bytes));
    sourceBytesDigested = 0;
    await act(async () => { await hookApi!.loadFile(file); });
    await settle();
    assert.equal(onlyModel()?.cacheState, 'hit', 'the entry was served');
    assert.ok(await getCached(key), 'a byte-identical source keeps its entry (no purge, no reload)');
    assert.equal(progressPhases.filter((p) => p === 'Checking cache').length, 1, 'no reload was started');
    assert.equal(onlyModel()?.sourceContentHash, referenceIdentity(bytes));
    assert.ok(sourceBytesDigested <= bytes.byteLength,
      `the source is digested at most once per load (digested ${sourceBytesDigested} of ${bytes.byteLength} bytes)`);
  });

  it('still purges and reloads when the stored hash disagrees with the source', async () => {
    const bytes = stepBytes(CACHE_SIZE_THRESHOLD + 4096);
    const file = new File([bytes as BlobPart], 'warm-mismatch.ifc');
    // An mtime-preserved, length-preserving edit: the entry was written for other bytes.
    const key = await seedCacheEntry(file, referenceIdentity(stepBytes(CACHE_SIZE_THRESHOLD + 4096, 0x41)));
    await act(async () => { await hookApi!.loadFile(file); });
    await settle();
    assert.equal(await getCached(key), null, 'the stale entry is purged');
    assert.equal(progressPhases.filter((p) => p === 'Checking cache').length, 2, 'the file is reloaded');
  });

  it('never serves an entry whose stored hash predates the shared identity', async () => {
    const bytes = stepBytes(CACHE_SIZE_THRESHOLD + 4096);
    const file = new File([bytes as BlobPart], 'warm-legacy.ifc');
    // Written by an older viewer: a bare whole-file SHA-256 the load can no longer compare.
    const key = await seedCacheEntry(file, sha256(bytes));
    await act(async () => { await hookApi!.loadFile(file); });
    await settle();
    assert.notEqual(onlyModel()?.cacheState, 'hit', 'an entry the load cannot validate is not served');
    assert.ok(progressPhases.includes('Starting geometry streaming'), 'the file is parsed instead');
    assert.equal(await getCached(key), null, 'the unverifiable entry is dropped so the reparse can rewrite it');
  });
});

// The viewer mounts drawing persistence beside every load. It used to hash the
// whole file again for its storage key; it now uses the load's identity.
describe('useIfcLoader — a primary load with drawing persistence mounted hashes the source once (#7035)', () => {
  const MARKUP_PREFIX = 'ifc-lite:drawing2d-markup:v1:';
  function DrawingProbe(): null {
    useDrawing2DPersistence();
    return null;
  }
  let drawingRoot: Root | null = null;
  let drawingContainer: HTMLDivElement | null = null;
  const passes = (name: string) => perfCounters.read()[`${name}.count`] ?? 0;

  beforeEach(async () => {
    localStorage.clear();
    perfCounters.enable(); // what `?perfTrace=1` and the benchmark do; this file's process only
    drawingContainer = document.createElement('div');
    document.body.appendChild(drawingContainer);
    drawingRoot = createRoot(drawingContainer);
    await act(async () => { drawingRoot!.render(<DrawingProbe />); });
  });
  afterEach(async () => {
    const current = drawingRoot;
    drawingRoot = null;
    if (current) await act(async () => current.unmount());
    drawingContainer?.remove();
    drawingContainer = null;
    localStorage.clear();
  });

  async function loadAndRestore(bytes: Uint8Array, name: string): Promise<void> {
    await act(async () => { await hookApi!.loadFile(new File([bytes as BlobPart], name)); });
    await waitFor(() => hasPersistedMarkupEntryFor(onlyModel()!.id) !== 'pending', 'the drawing restore to settle');
    await settle(100); // a second pass, if one were started, would have been counted by now
  }

  it('the hash-pass counter reads 1 per primary load with no legacy entry', async () => {
    const bytes = glbBytes(4);
    const before = { full: passes('hash.fullSource'), legacy: passes('hash.drawingLegacyKey') };
    await loadAndRestore(bytes, 'drawing-mounted.glb');
    assert.equal(passes('hash.fullSource') - before.full, 1, 'full-source hash passes for the load');
    assert.equal(passes('hash.drawingLegacyKey') - before.legacy, 0, 'no legacy-key pass');

    await act(async () => {
      useViewerStore.setState({ measure2DResults: [{ id: 'drawn', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }] });
    });
    assert.ok(localStorage.getItem(MARKUP_PREFIX + referenceIdentity(bytes)), 'markup drawn after the load is stored under the load\'s identity');
  });

  it('a legacy entry adds one pass, reported under its own counter', async () => {
    const bytes = glbBytes(5);
    localStorage.setItem(MARKUP_PREFIX + sha256(bytes), JSON.stringify({
      measure2DResults: [{ id: 'legacy-1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
      polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
      drawing2DDisplayOptions: {}, sectionConfig: null, savedAt: 1,
    }));
    const before = { full: passes('hash.fullSource'), legacy: passes('hash.drawingLegacyKey') };
    await loadAndRestore(bytes, 'drawing-legacy.glb');
    assert.equal(passes('hash.fullSource') - before.full, 1, 'the load itself still makes one full-source pass');
    assert.equal(passes('hash.drawingLegacyKey') - before.legacy, 1, 'the extra pass is visible, not hidden');
    assert.deepEqual(useViewerStore.getState().measure2DResults.map((m) => m.id), ['legacy-1']);
    assert.equal(localStorage.getItem(MARKUP_PREFIX + sha256(bytes)), null);
    assert.ok(localStorage.getItem(MARKUP_PREFIX + referenceIdentity(bytes)));
  });
});
