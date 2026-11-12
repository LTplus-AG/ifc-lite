/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On a fresh page the viewport mounts with a load's own interface reset, and
 * its renderer used to ask for a WebGPU device only then: 110-150 ms of reset
 * sat in front of a 160-370 ms device request on every first open (Holter,
 * BWK and advanced_model snapshot reopens, pre-pixel lane itemisation
 * 2026-11-12). `loadFile` now asks for the device at the pick, before the
 * reset, and the renderer that mounts adopts it (device-request.ts).
 *
 * Driven through the real hook with a hand-stubbed `navigator.gpu`:
 *  - with no renderer mounted, the device is requested before the reset
 *    starts the load, and a renderer initialised afterwards adopts exactly
 *    that device instead of requesting another;
 *  - with a renderer already mounted, nothing is requested early.
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebGPUDevice, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { StringTable, EntityTableBuilder, PropertyTableBuilder, QuantityTableBuilder, RelationshipGraphBuilder } from '@ifc-lite/data';
import { BinaryCacheWriter, computeSourceFingerprint, type CacheDataStore } from '@ifc-lite/cache';
import { CACHE_SIZE_THRESHOLD } from '@/utils/ifcConfig.js';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { setCached } from '../services/cacheService.js';
import { useIfcLoader } from './useIfcLoader.js';
import { clearGlobalRefs, setGlobalRendererRef } from './useBCF.js';

(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x10 };

/** Order of the device request and the load's reset, as the loader makes them. */
const order: string[] = [];

function installGpu() {
  const adapterCalls: string[] = [];
  const devices: object[] = [];
  const adapter = {
    features: new Set<string>(),
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 29 },
    requestDevice: async () => {
      order.push('requestDevice');
      const device = { lost: new Promise(() => {}), limits: { maxTextureDimension2D: 8192 }, features: new Set(), destroy() {} };
      devices.push(device);
      return device;
    },
  };
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: async () => {
        adapterCalls.push('requestAdapter');
        order.push('requestAdapter');
        return adapter;
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  return { adapterCalls, devices };
}

const fakeCanvas = () => ({ width: 64, height: 64, getContext: () => ({ configure: () => {} }) }) as unknown as HTMLCanvasElement;

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const realReset = useViewerStore.getState().resetViewerState;
beforeEach(async () => {
  realReset();
  useViewerStore.getState().clearAllModels();
  order.length = 0;
  useViewerStore.setState({ resetViewerState: () => { order.push('reset'); realReset(); } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
});

afterEach(async () => {
  useViewerStore.setState({ resetViewerState: realReset });
  delete (globalThis.navigator as { gpu?: unknown }).gpu;
  clearGlobalRefs();
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
});

/** A load that ends early (an unknown format) is enough: the request happens at the pick. */
const someFile = () => new File([new Uint8Array(64)], 'not-a-model.bin');

describe('useIfcLoader — the renderer device is requested at the pick (pre-pixel lane)', () => {
  it('asks before the reset when no renderer is mounted, and the mounting renderer adopts that device', async () => {
    const gpu = installGpu();
    await act(async () => { await hookApi!.loadFile(someFile()).catch(() => {}); });

    assert.equal(gpu.adapterCalls.length, 1, 'no early device request was made');
    assert.deepEqual(order, ['requestAdapter', 'requestDevice', 'reset'], 'the device request was not in flight before the load reset the interface');
    assert.equal(gpu.devices.length, 1);

    const device = new WebGPUDevice();
    await device.init(fakeCanvas());
    assert.equal(gpu.adapterCalls.length, 1, 'the renderer requested its own adapter instead of adopting the early one');
    assert.equal(gpu.devices.length, 1, 'the renderer requested a second device');
    assert.equal(device.getDevice() !== null, true);
  });

  it('asks for nothing early when a renderer is already mounted', async () => {
    const gpu = installGpu();
    const ref = createRef<Renderer | null>() as { current: Renderer | null };
    ref.current = {} as Renderer;
    setGlobalRendererRef(ref);
    await act(async () => { await hookApi!.loadFile(someFile()).catch(() => {}); });
    assert.equal(gpu.adapterCalls.length, 0);
  });
});

// ─── Setup hold: every exit of the load lets the renderer's setup go ─────────
const releases = () => performance.getEntriesByType('mark').map((m) => m.name).filter((n) => n.startsWith('renderer.setupReleased:')).map((n) => n.slice('renderer.setupReleased:'.length));

function stepBytes(targetBytes: number): Uint8Array {
  const header = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n");
  const footer = new TextEncoder().encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const bytes = new Uint8Array(targetBytes).fill(0x20);
  bytes.set(header, 0);
  bytes.set(footer, targetBytes - footer.length);
  return bytes;
}

/** The load's full-source identity, computed independently (as useIfcLoader.sourceHashOnce.test.tsx does). */
function referenceIdentity(bytes: Uint8Array): string {
  const MIB = 1024 * 1024;
  const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
  const parts = [`placement-sha256-1m-v1:${bytes.byteLength}`];
  for (let start = 0; start < bytes.byteLength; start += MIB) parts.push(sha(bytes.subarray(start, start + MIB)));
  return `placement-sha256-1m-v1:${sha(parts.join(':'))}`;
}

/** A metadata-only entry under the key `loadFile` derives, stored as a plain ArrayBuffer (fake-indexeddb cannot clone a Blob). */
async function seedHit(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const strings = new StringTable();
  const entities = new EntityTableBuilder(2, strings);
  entities.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
  const store: CacheDataStore = { schema: 1, entityCount: 1, strings, entities: entities.build(), properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(), relationships: new RelationshipGraphBuilder().build() };
  const payload = await new BinaryCacheWriter().write(store, undefined, buffer, { includeGeometry: false, omitSourceHash: true }) as ArrayBuffer;
  const state = useViewerStore.getState();
  const key = buildGeometryCacheKey(buffer.byteLength, computeSourceFingerprint(buffer).hex, state.mergeLayers, undefined,
    state.geometryMode === 'fast', resolveLoadTessellationTier(buffer.byteLength / (1024 * 1024), state.geometryMode));
  await setCached(key, payload, file.name, buffer.byteLength, buffer, { lastModified: file.lastModified, fullSourceHash: referenceIdentity(new Uint8Array(buffer)) });
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('ifc-lite-cache'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('models', 'readwrite');
    const os = tx.objectStore('models');
    const get = os.get(key);
    get.onsuccess = () => os.put({ ...(get.result as Record<string, unknown>), buffer: payload });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('useIfcLoader — the early device\'s setup waits until the load knows its path (#9825 fix a)', () => {
  beforeEach(() => performance.clearMarks());
  // An unclaimed early request would make the next test's pick find one pending (and hold nothing): claim it.
  afterEach(async () => {
    if (!(globalThis.navigator as { gpu?: unknown }).gpu) installGpu();
    await new WebGPUDevice().init(fakeCanvas()).then(() => {}, (err: unknown) => console.warn('drain init failed', err));
  });

  it('a file that is not plain STEP lets setup go at once', async () => {
    installGpu();
    await act(async () => { await hookApi!.loadFile(someFile()).catch(() => {}); });
    assert.deepEqual(releases(), ['other-path']);
  });

  it('a cold STEP load holds setup past its reset and read, and lets it go at its geometry (or its exit)', async () => {
    installGpu();
    const file = new File([stepBytes(4096) as BlobPart], 'cold.ifc');
    await act(async () => { await hookApi!.loadFile(file).catch(() => {}); });
    const seen = releases();
    assert.equal(seen.length, 1, `released ${seen.join(', ')}`);
    // With the WASM engine the first geometry pull releases it; without it, engine init fails and the exit does.
    assert.ok(seen[0] === 'cold-geometry' || seen[0] === 'load-ended', `a cold STEP load released setup on '${seen[0]}'`);
  });

  it('a servable cache hit lets setup go before it serves the entry', async () => {
    installGpu();
    const bytes = stepBytes(CACHE_SIZE_THRESHOLD + 4096);
    const file = new File([bytes as BlobPart], 'hit.ifc');
    await seedHit(file);
    await act(async () => { await hookApi!.loadFile(file).catch(() => {}); });
    assert.equal(releases()[0], 'cache-hit');
    assert.equal([...useViewerStore.getState().models.values()][0]?.cacheState, 'hit');
  });

  it('a load superseded before its reset still lets setup go, so the next renderer is not held', async () => {
    installGpu();
    const first = new File([stepBytes(4096) as BlobPart], 'first.ifc');
    await act(async () => {
      const a = hookApi!.loadFile(first).catch(() => {});
      const b = hookApi!.loadFile(someFile()).catch(() => {});
      await Promise.all([a, b]);
    });
    assert.ok(releases().includes('load-ended'), `released ${releases().join(', ')}`);
    const started = Date.now();
    await new WebGPUDevice().init(fakeCanvas());
    assert.ok(Date.now() - started < 500, 'the renderer waited on a gate its superseded load never opened');
  });
});
