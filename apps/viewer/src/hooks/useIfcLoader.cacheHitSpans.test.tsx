/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A traced cache HIT records the spans of its post-pixel stretch: the hit's
 * finalize (`load.finalize`, as on the cold path), the wait for the load's
 * identity pass (`finalize.identityWait`), the commit that marks the model
 * complete (`finalize.publish`) and the UI settle (`load.settleUi`). These are
 * what the load scoreboard attributes between metadata ready and interactive.
 *
 * Tracing is requested the way a benchmark does, before the viewer's modules
 * evaluate (`?perfTrace=1`), so everything below is imported afterwards.
 * Fixtures and the payload re-store are the ones of
 * `useIfcLoader.cacheHitTelemetry.test.tsx`.
 */
import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

globalThis.history.replaceState(null, '', '/?perfTrace=1');
const { StringTable, EntityTableBuilder, PropertyTableBuilder, QuantityTableBuilder, RelationshipGraphBuilder } = await import('@ifc-lite/data');
const { BinaryCacheWriter, computeSourceFingerprint } = await import('@ifc-lite/cache');
type CacheDataStore = import('@ifc-lite/cache').CacheDataStore;
type TessellationQuality = import('@ifc-lite/geometry').TessellationQuality;
const { settle } = await import('@/test/settle.js');
const { advance } = await import('@/test/render.js');
const { useViewerStore } = await import('@/store');
const { CACHE_SIZE_THRESHOLD } = await import('@/utils/ifcConfig.js');
const { resolveLoadTessellationTier } = await import('@/store/constants.js');
const { buildGeometryCacheKey } = await import('./geometryCacheKey.js');
const { setCached } = await import('../services/cacheService.js');
const tracing = await import('../lib/perf/loadTrace.js');
await tracing.loadTracerReady; // `loadTracer` is re-bound once the recording tracer loads: read it through the namespace
const { useIfcLoader } = await import('./useIfcLoader.js');

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A STEP file of an exact byte length (same builder as
 *  `useIfcLoader.cacheStaleness.test.tsx`): the interior is never parsed,
 *  because the cache hit is served before any parse runs. */
function buildStepFile(name: string, targetBytes: number): File {
  const header = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n");
  const footer = new TextEncoder().encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const padLen = Math.max(0, targetBytes - header.length - footer.length);
  const bytes = new Uint8Array(header.length + padLen + footer.length);
  bytes.set(header, 0);
  bytes.fill(0x20, header.length, header.length + padLen);
  bytes.set(footer, header.length + padLen);
  return new File([bytes], name);
}

/** Minimal but valid `CacheDataStore` — enough for `BinaryCacheReader` to
 *  restore a store, which is what makes the hit SERVE rather than miss. */
function buildMinimalCacheDataStore(): CacheDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
  return {
    schema: 1,
    entityCount: 1,
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

/**
 * Re-store the entry's payload as a plain `ArrayBuffer`.
 *
 * `setCached` wraps the payload in a `Blob` (disk-backed in a real IndexedDB).
 * `fake-indexeddb`'s structured clone does not preserve happy-dom's `Blob` —
 * it comes back as a plain object, so `readHeader` throws and the hit degrades
 * to a miss. That is a harness artifact, not a product defect: the loader
 * reads `rawCacheBuffer instanceof Blob ? await …arrayBuffer() : rawCacheBuffer`
 * (`useIfcCache.ts`), so an `ArrayBuffer` payload is the OTHER branch of a
 * shape the production reader already supports — not a bypass of it. Only the
 * container changes here; the bytes, the key, and every field the cache-hit
 * decision reads are the ones `setCached` wrote.
 */
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
    get.onsuccess = () => {
      const entry = get.result as Record<string, unknown> | undefined;
      assert.ok(entry, `setCached must have written an entry for ${key}`);
      store.put({ ...entry, buffer: payload });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

/** The SAME cache key `loadFile` derives, from the same helpers and the same
 *  store fields it reads — not a guess at their output. */
function cacheKeyFor(buffer: ArrayBuffer, tierOverride?: TessellationQuality): string {
  const { hex } = computeSourceFingerprint(buffer);
  const state = useViewerStore.getState();
  const skipSmallCuts = state.geometryMode === 'fast';
  // `loadFile` prefers an explicit `tierOverride` (the resource-retry's forced
  // tier) over the resolved one, and builds the cache key from the winner — so
  // the key derived here must resolve it the same way or the hit becomes a miss.
  const tessellationTier = tierOverride
    ?? resolveLoadTessellationTier(buffer.byteLength / (1024 * 1024), state.geometryMode);
  return buildGeometryCacheKey(buffer.byteLength, hex, state.mergeLayers, undefined, skipSmallCuts, tessellationTier);
}

// ─── Harness: the real hook, rendered ────────────────────────────────────

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('useIfcLoader: a traced cache hit spans its store publish, finalize and settle', () => {
  it('records load.finalize with finalize.identityWait and finalize.publish inside it, then load.settleUi', async () => {
    assert.equal(tracing.loadTracer.enabled, true, 'the recording tracer is on (?perfTrace=1)');
    const file = buildStepFile('cache-hit-spans.ifc', CACHE_SIZE_THRESHOLD + 4096);
    const buffer = await file.arrayBuffer();
    const entry = await new BinaryCacheWriter().write(buildMinimalCacheDataStore(), undefined, buffer, { includeGeometry: false, omitSourceHash: true });
    const key = cacheKeyFor(buffer);
    await setCached(key, entry as ArrayBuffer, file.name, buffer.byteLength, buffer);
    await storePayloadAsArrayBuffer(key, entry as ArrayBuffer);

    await act(async () => { await hookApi!.loadFile(file, { kind: 'primary' }); });
    const hitLoad = () => tracing.loadTracer.snapshots().find((l) => l.attrs?.loadPath === 'cache');
    for (let i = 0; i < 400 && !hitLoad()?.spans.some((s) => s.name === 'load.settleUi' && s.end !== null); i++) await advance(5);
    await act(async () => { await settle('cache-hit spans drained'); });

    const load = hitLoad();
    assert.ok(load, 'the load was served from the cache');
    const span = (name: string) => load.spans.filter((s) => s.name === name && s.end !== null);
    const finalize = span('load.finalize');
    assert.equal(finalize.length, 1, 'one load.finalize on the hit');
    for (const inner of ['finalize.identityWait', 'finalize.publish']) {
      const found = span(inner);
      assert.equal(found.length, 1, `one ${inner}`);
      assert.ok(found[0].start >= finalize[0].start && found[0].end! <= finalize[0].end!, `${inner} lies inside load.finalize`);
    }
    const publish = span('cache.publishStore');
    assert.equal(publish.length, 1, 'one cache.publishStore (this entry has no geometry: the metadata-only branch)');
    assert.ok(publish[0].end! <= finalize[0].start, 'the store is published before the finalize');
    const settleUi = span('load.settleUi');
    assert.equal(settleUi.length, 1, 'one load.settleUi');
    assert.ok(settleUi[0].start >= finalize[0].end!, 'the settle follows the finalize');
  });
});
