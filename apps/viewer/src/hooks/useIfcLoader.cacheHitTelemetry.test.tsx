/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cache-hit half of the #2388 geometry attribution, driven for real.
 *
 * `modelLoadedGeometryProps.test.ts` unit-tests the BUILDER; this file tests
 * the WIRING behaviourally — it seeds a real cache entry, drives the real
 * `useIfcLoader.loadFile` to a real cache HIT, and reads the actual
 * `ifc_model_loaded` event that leaves the capture seam. Nothing here reads
 * the text of `useIfcLoader.ts`.
 *
 * **Why the cache path IS reachable under `tsx --test`** (unlike the wasm
 * path, which dies in `GeometryProcessor.init()` on the `file://` WASM fetch):
 * the hit is decided at `loadStage = 'cache-lookup'`, hundreds of lines before
 * the geometry engine is touched, and serving it needs only IndexedDB — which
 * `fake-indexeddb` provides. The harness (seeded entry, rendered hook, real
 * `loadFile`) is the one `useIfcLoader.cacheStaleness.test.tsx` already
 * established for exactly this branch.
 *
 * **The observable.** `posthog.capture` — the single sink every
 * `ifc_model_loaded` capture site reaches through `captureModelLoaded`
 * (`utils/loadTelemetry.ts`, which keeps the event-name literal private). It
 * is swapped for a collector the same way `loadTelemetry.test.ts` does it (a
 * plain property swap; this repo rejects `mock.module`). No production code
 * was added for this test.
 *
 * **Why two loads and not one.** A single expectation (`skip_small_cuts:
 * true`, `tessellation_tier: 'low'`) is satisfiable by hardcoded constants at
 * the capture site. Two cache hits under OPPOSITE fidelity settings — `fast` +
 * `?geomTier=low` vs `exact` + `?geomTier=high` — force both fields to move
 * with the load's real inputs, which is the property #2388 needs: the event
 * must describe the geometry THIS load served, not a default.
 *
 * The third assertion is the absence one: a cache hit runs no streaming
 * `complete` event, so there are no CSG counters for it. They must be ABSENT
 * from the payload, not a fabricated `0` (which reads as "CSG ruled out") and
 * not a prior load's values carried over.
 *
 * The last case covers `is_resource_retry`, and it needs the same
 * two-contrasting-loads treatment for a sharper reason: the auto-retry always
 * runs at `'lowest'`, and a first attempt reaches `'lowest'` on its own, so a
 * single retry assertion would also pass for a flag inferred from the tier. It
 * is paired with a NON-retry load at the identical tier.
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
} from '@ifc-lite/data';
import { BinaryCacheWriter, type CacheDataStore } from '@ifc-lite/cache';
import type { TessellationQuality } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { CACHE_SIZE_THRESHOLD } from '@/utils/ifcConfig.js';
import { GEOM_TIER_STORAGE_KEY, type GeometryMode } from '@/store/geometryFidelity.js';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { computeSourceFingerprint } from './sourceFingerprint.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { setCached } from '../services/cacheService.js';
import { useIfcLoader } from './useIfcLoader.js';

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
let captured: Array<Record<string, unknown>> = [];
const realCapture = posthog.capture;

beforeEach(async () => {
  hookApi = null;
  captured = [];
  posthog.capture = ((event: string, props?: Record<string, unknown>) => {
    if (event === 'ifc_model_loaded') captured.push({ ...(props ?? {}) });
    return undefined;
  }) as typeof posthog.capture;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  posthog.capture = realCapture;
  localStorage.removeItem(GEOM_TIER_STORAGE_KEY);
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

/**
 * Seed a cache entry for `fileName` under the given fidelity settings, load it
 * through the real hook, and return the single `ifc_model_loaded` payload the
 * resulting cache HIT emitted.
 */
async function captureCacheHitPayload(
  fileName: string,
  mode: GeometryMode,
  tierPin: TessellationQuality | null,
  /** Passed through to `loadFile` verbatim — the same options object the
   *  resource-retry re-entry builds (`tryResourceRetry` in `useIfcLoader.ts`). */
  loadOptions?: { tierOverride?: TessellationQuality; isResourceRetry?: boolean },
): Promise<Record<string, unknown>> {
  // Set the fidelity inputs BEFORE deriving the key: `loadFile` reads
  // `geometryMode` from the store and the tier override from localStorage, and
  // both discriminate the cache key — a hit is only reachable when the key
  // built here matches the one the load derives.
  await act(async () => {
    useViewerStore.setState({ geometryMode: mode });
  });
  if (tierPin === null) localStorage.removeItem(GEOM_TIER_STORAGE_KEY);
  else localStorage.setItem(GEOM_TIER_STORAGE_KEY, tierPin);

  // Big enough for the source-persisting cache tier (>= CACHE_SIZE_THRESHOLD).
  const file = buildStepFile(fileName, CACHE_SIZE_THRESHOLD + 4096);
  const buffer = await file.arrayBuffer();
  const entryBuffer = await new BinaryCacheWriter().write(
    buildMinimalCacheDataStore(),
    undefined,
    buffer,
    { includeGeometry: false, omitSourceHash: true },
  );
  // A `sourceBuffer` is supplied so the entry is not source-decoupled: the
  // mtime/hash gate is skipped and the hit is served unconditionally.
  const cacheKey = cacheKeyFor(buffer, loadOptions?.tierOverride);
  await setCached(cacheKey, entryBuffer as ArrayBuffer, file.name, buffer.byteLength, buffer);
  await storePayloadAsArrayBuffer(cacheKey, entryBuffer as ArrayBuffer);

  // Only this load's events: the first test drives two loads in one case, and
  // "exactly one cache hit" must be a statement about THIS one.
  captured.length = 0;
  await act(async () => {
    await hookApi!.loadFile(file, { kind: 'primary' }, loadOptions);
  });

  const hits = captured.filter((p) => p.load_path === 'cache');
  assert.equal(
    hits.length,
    1,
    `expected exactly one cache-hit ifc_model_loaded event, got ${hits.length} `
    + `(all captured load_paths: ${JSON.stringify(captured.map((p) => p.load_path))}). `
    + 'A count of 0 means the load never reached the cache-hit branch, so this '
    + 'test would prove nothing — fix the fixture, do not relax the assertion.',
  );
  return hits[0]!;
}

describe('useIfcLoader — a cache HIT reports the geometry fidelity it served (#2388)', () => {
  it('carries the load\'s real tessellation tier and small-cut skip on the ifc_model_loaded event', async () => {
    // `fast` + a `low` tier pin.
    const fast = await captureCacheHitPayload('cache-hit-fast.ifc', 'fast', 'low');
    assert.equal(fast.tessellation_tier, 'low');
    assert.equal(fast.skip_small_cuts, true);

    // The OPPOSITE settings must move BOTH fields — a constant at the capture
    // site, or a builder call fed hardcoded inputs, dies here.
    const exact = await captureCacheHitPayload('cache-hit-exact.ifc', 'exact', 'high');
    assert.equal(exact.tessellation_tier, 'high');
    assert.equal(exact.skip_small_cuts, false);
  });

  it('leaves the CSG counters ABSENT on a cache hit — no streaming complete event ran', async () => {
    const payload = await captureCacheHitPayload('cache-hit-no-csg.ifc', 'fast', 'low');
    for (const field of [
      'total_csg_failures',
      'csg_products_with_failures',
      'csg_silent_no_ops',
      'csg_top_failure_reason',
    ]) {
      assert.equal(
        payload[field],
        undefined,
        `${field} must stay absent on a cache hit: a fabricated 0 reads as `
        + '"CSG ruled out" for a load that never counted, which is the '
        + 'mis-attribution #2388 exists to prevent',
      );
    }
    // The fidelity fields must still be there — "absent CSG" must not be
    // achieved by dropping the whole geometry-props spread.
    assert.equal(payload.tessellation_tier, 'low');
    assert.equal(payload.skip_small_cuts, true);
  });

  it('distinguishes a resource-limit retry from a first attempt that resolved to the SAME tier', async () => {
    // The retry re-enters `loadFile` with exactly these options
    // (`tryResourceRetry`: `{ ...options, tierOverride: retryTier,
    // isResourceRetry: true }`), and `resolveResourceRetryTier` only ever
    // returns `'lowest'`.
    const retry = await captureCacheHitPayload(
      'cache-hit-retry.ifc',
      'fast',
      null,
      { tierOverride: 'lowest', isResourceRetry: true },
    );

    // The contrast that makes the flag mean something: a NORMAL first attempt
    // that lands on `'lowest'` all by itself — here via a pinned
    // `?geomTier=lowest`, the same value `AUTO_LOWEST_TIER_MB` (150) hands any
    // fast-mode file at or above that size. Its tier is byte-identical to the
    // retry's, so `tessellation_tier` alone cannot separate the two; only a
    // flag threaded from the load's own options can.
    const firstAttempt = await captureCacheHitPayload(
      'cache-hit-first-lowest.ifc',
      'fast',
      'lowest',
    );

    assert.equal(retry.tessellation_tier, 'lowest');
    assert.equal(firstAttempt.tessellation_tier, 'lowest');
    assert.equal(
      retry.tessellation_tier,
      firstAttempt.tessellation_tier,
      'the two loads must be indistinguishable by tier — that is the ambiguity '
      + 'this field exists to resolve; if they differ, the fixture no longer '
      + 'tests it',
    );

    assert.equal(
      retry.is_resource_retry,
      true,
      'a load re-entered with isResourceRetry must say so on ifc_model_loaded, '
      + 'not only on the failure capture that started it',
    );
    // Not `undefined`: a dropped `false` is indistinguishable from a client
    // that never reported the field, which is what makes the retry rows
    // unfilterable in the first place.
    assert.equal(
      firstAttempt.is_resource_retry,
      false,
      'a normal first attempt at `lowest` must report false — a constant `true` '
      + 'at the capture site, or a value inferred from the tier, dies here',
    );
  });
});
