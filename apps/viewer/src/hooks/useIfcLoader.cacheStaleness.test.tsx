/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader-side half of PR #2301 has no test of its own (#2301 review,
 * 2026-08-10T18:50): `useIfcLoader.ts` — `if (cacheOutcome === 'stale')
 * return;` — delete that line and the whole suite stays green.
 * `useIfcCache.staleness.test.tsx` drives `loadFromCache` directly with an
 * injected `isStale` predicate; it never renders or drives `useIfcLoader`,
 * so it cannot see whether the CALLER honours the outcome `loadFromCache`
 * reports.
 *
 * `loadFromCache` returns the SAME `{ success: false }` for an ordinary
 * cache miss as for a superseded load. Without the guard this test pins, a
 * superseded load falls through past the cache block into "Try server
 * parsing" / local WASM — a full, wasted reparse of the file the user is no
 * longer looking at, racing the newer load for workers — which is exactly
 * the race PR #2301 exists to close, just moved one step later and made far
 * more expensive.
 *
 * **How this is driven without a real WASM engine.** Two overlapping primary
 * `loadFile` calls reproduce the real race: `loadFile`'s session bump
 * (`++loadSessionRef.current`) is its very first statement, before any
 * `await`, so firing `loadFile(fileA)` then `loadFile(fileB)` back-to-back
 * (both synchronous up to their own first `await`) deterministically leaves
 * `fileA`'s session stale by the time it reaches the cache branch — no
 * timing race, no flakiness. `fileA` is sized and fingerprinted to hit a
 * real cache entry seeded via `fake-indexeddb` (the same technique
 * `ifc-cache.test.ts` uses); `fileB` is a plain small file, so its own load
 * needs no cache round-trip at all.
 *
 * **The observable.** `setProgress` is wrapped (not `mock.module`, which
 * this repo rejects — see `ExtensionHostProvider.tsx`) to count calls whose
 * `phase` is `'Starting geometry streaming'`, the first unconditional write
 * on entry to the local WASM path (unconditional because `USE_SERVER` is
 * false under `tsx --test`, so nothing else can gate it). Exactly one call
 * is correct: `fileB`, the winning load, legitimately enters that path once.
 * A second call can only come from `fileA` wrongly falling through after
 * being superseded — the counting (not a final-state check) is what makes
 * this unambiguous, since both loads would otherwise leave the SAME phase
 * string behind.
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
import { useViewerStore } from '@/store';
import { CACHE_SIZE_THRESHOLD } from '@/utils/ifcConfig.js';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { computeSourceFingerprint } from './sourceFingerprint.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { getCached, setCached } from '../services/cacheService.js';
import { useIfcLoader } from './useIfcLoader.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A STEP file of an exact byte length, padded with harmless filler bytes
 *  between a real header/footer. Content correctness past the header doesn't
 *  matter: `fileA`'s cache lookup always resolves via the guard under test
 *  before anything reads the buffer's interior, and `fileB` never reaches a
 *  real parse either (Node has no WASM engine) — every assertion here is
 *  about how many times the WASM path is ENTERED, not what it produces. */
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

/** Minimal but valid `CacheDataStore` — never actually read: `fileA`'s
 *  `isStale` check is the very first statement in `loadFromCache`, before
 *  the entry's buffer is even materialized. Its only job is to make
 *  `getCached` return a truthy hit so `fileA` reaches the guard at all. */
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

/** Compute the SAME cache key `useIfcLoader.loadFile` would derive for this
 *  buffer, from the same store fields and the same helper functions it uses
 *  (`buildGeometryCacheKey`, `computeSourceFingerprint`,
 *  `resolveLoadTessellationTier`) — not a guess at their output. */
function cacheKeyFor(buffer: ArrayBuffer): string {
  const { hex } = computeSourceFingerprint(buffer);
  const state = useViewerStore.getState();
  const skipSmallCuts = state.geometryMode === 'fast';
  const tessellationTier = resolveLoadTessellationTier(buffer.byteLength / (1024 * 1024), state.geometryMode);
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
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe('useIfcLoader — a superseded cache-hit load must not fall through to a reparse (#2301)', () => {
  it('the winning load enters the local WASM path exactly once, not twice', async () => {
    // fileA: big enough to qualify for the source-persisting cache tier
    // (CACHE_SIZE_THRESHOLD .. CACHE_MAX_SOURCE_SIZE) and seeded into the
    // (fake) IndexedDB cache under its own real cache key.
    const fileA = buildStepFile('cache-staleness-A.ifc', CACHE_SIZE_THRESHOLD + 4096);
    const bufferA = await fileA.arrayBuffer();
    const cacheKey = cacheKeyFor(bufferA);

    const entryBuffer = await new BinaryCacheWriter().write(
      buildMinimalCacheDataStore(),
      undefined,
      bufferA,
      { includeGeometry: false, omitSourceHash: true },
    );
    // A `sourceBuffer` is supplied so the entry is NOT source-decoupled, and
    // no stored mtime is supplied so `decideSourceTierCacheHit` serves —
    // `fileA` reaches the `isStale` guard unconditionally.
    await setCached(cacheKey, entryBuffer as ArrayBuffer, fileA.name, bufferA.byteLength, bufferA);

    // fileB: well under CACHE_SIZE_THRESHOLD, so its own load never touches
    // the cache at all — it reaches the WASM path by the plain no-cache path.
    const fileB = buildStepFile('cache-staleness-B.ifc', 2048);

    let startingStreamCalls = 0;
    const realSetProgress = useViewerStore.getState().setProgress;
    await act(async () => {
      useViewerStore.setState({
        setProgress: (p) => {
          if (p?.phase === 'Starting geometry streaming') startingStreamCalls++;
          return realSetProgress(p);
        },
      });
    });
    // The wrapper replaces a store action referenced in `loadFile`'s own
    // `useCallback` deps, so the hook must have re-rendered before firing
    // the loads below — otherwise `hookApi.loadFile` would still close over
    // the ORIGINAL `setProgress` and this test would prove nothing.
    assert.notEqual(
      useViewerStore.getState().setProgress,
      realSetProgress,
      'the wrapped setProgress must have replaced the original in the store',
    );

    // The real race: two primary loads back-to-back. `loadFile` bumps
    // `loadSessionRef` as its first statement, before any `await`, so by
    // the time `fileA` resumes past its own first `await` it is already
    // stale — deterministically, not by timing luck.
    await act(async () => {
      const pending = [hookApi!.loadFile(fileA), hookApi!.loadFile(fileB)];
      await Promise.allSettled(pending);
    });

    assert.equal(
      startingStreamCalls,
      1,
      'exactly one primary load may enter the local WASM path — the winning '
      + '(non-stale) load. A superseded cache-hit load falling through to a '
      + 'full reparse of the OLD file would enter it a second time, which is '
      + 'the fall-through PR #2301 exists to close (useIfcLoader.ts, '
      + "`if (cacheOutcome === 'stale') return;`).",
    );
  });
});

describe('useIfcLoader — the source-persisting tier gates on mtime before serving (#4269)', () => {
  /** Wrap `setProgress` to count entries into the local WASM path, and prove
   *  the hook re-rendered over the wrapper (same technique as above). */
  async function countWasmEntries(): Promise<() => number> {
    let calls = 0;
    const realSetProgress = useViewerStore.getState().setProgress;
    await act(async () => {
      useViewerStore.setState({
        setProgress: (p) => {
          if (p?.phase === 'Starting geometry streaming') calls++;
          return realSetProgress(p);
        },
      });
    });
    assert.notEqual(
      useViewerStore.getState().setProgress,
      realSetProgress,
      'the wrapped setProgress must have replaced the original in the store',
    );
    return () => calls;
  }

  /** Count the gate's own rejection line (`cache MISS (source changed /
   *  unvalidatable)`), logged ONLY by the pre-serve staleness gate — never by
   *  the corrupt-entry cleanup inside `loadFromCache` — so it distinguishes a
   *  gate MISS from every other way an entry can disappear. Restores
   *  `console.warn` via the returned cleanup. */
  function countGateMisses(): { count: () => number; restore: () => void } {
    let calls = 0;
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('cache MISS (source changed / unvalidatable)')) calls++;
      return realWarn(...args);
    };
    return { count: () => calls, restore: () => { console.warn = realWarn; } };
  }

  /** Seed a SOURCE-PERSISTING entry (sourceBuffer supplied) for `file` whose
   *  stored mtime is `file.lastModified + skewMs`. */
  async function seedEntry(file: File, skewMs: number): Promise<string> {
    const buffer = await file.arrayBuffer();
    const cacheKey = cacheKeyFor(buffer);
    const entryBuffer = await new BinaryCacheWriter().write(
      buildMinimalCacheDataStore(),
      undefined,
      buffer,
      { includeGeometry: false, omitSourceHash: true },
    );
    await setCached(cacheKey, entryBuffer as ArrayBuffer, file.name, buffer.byteLength, buffer, {
      lastModified: file.lastModified + skewMs,
    });
    return cacheKey;
  }

  it('a hit whose stored mtime differs from the file is PURGED and reparsed, not served', async () => {
    // The #4269 defect: an in-place edit that preserves the byte length is
    // invisible to the spread-sampled key, so before the gate this entry was
    // served unconditionally. Any real on-disk edit bumps mtime; a stored
    // mtime differing from the fresh one must purge + reparse.
    const file = buildStepFile('cache-mtime-miss.ifc', CACHE_SIZE_THRESHOLD + 8192);
    const cacheKey = await seedEntry(file, -5000);
    const wasmEntries = await countWasmEntries();
    const gate = countGateMisses();

    try {
      await act(async () => {
        await Promise.allSettled([hookApi!.loadFile(file)]);
      });
    } finally {
      gate.restore();
    }

    assert.equal(
      gate.count(),
      1,
      'the pre-serve staleness gate itself must reject the mtime-mismatched '
      + 'hit (its distinctive `cache MISS (source changed / unvalidatable)` '
      + 'warn), not some later failure path (#4269)',
    );
    assert.equal(
      await getCached(cacheKey),
      null,
      'a source-persisting hit with a DIFFERENT stored mtime must be deleted, '
      + 'not served (#4269 — the pre-gate loader served it unconditionally)',
    );
    assert.equal(
      wasmEntries(),
      1,
      'the mtime-mismatched load must fall through to exactly one fresh local '
      + 'WASM parse instead of serving the stale entry',
    );
  });

  it('bounding control: a hit whose stored mtime MATCHES the file passes the gate un-rejected', async () => {
    // "Gate everything" would satisfy the miss test by rejecting every hit.
    // A matching mtime must pass the gate: its distinctive rejection warn must
    // not fire. (The gate decision — not a full served load — is the unit
    // under test here: under `tsx --test`, fake-indexeddb's Blob round-trip
    // hands `loadFromCache` a buffer it cannot read, so the post-gate load
    // ends in the corrupt-entry cleanup either way; asserting on the gate's
    // own warn keeps the control immune to that environment artifact.)
    const file = buildStepFile('cache-mtime-match.ifc', CACHE_SIZE_THRESHOLD + 12288);
    await seedEntry(file, 0);
    const gate = countGateMisses();

    try {
      await act(async () => {
        await Promise.allSettled([hookApi!.loadFile(file)]);
      });
    } finally {
      gate.restore();
    }

    assert.equal(
      gate.count(),
      0,
      'a source-persisting hit with a MATCHING stored mtime must not be '
      + 'rejected by the staleness gate (#4269 gates only a CHANGED mtime)',
    );
  });
});
