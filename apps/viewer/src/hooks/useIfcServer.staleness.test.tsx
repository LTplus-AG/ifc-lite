/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadFromServer`'s streaming path must never write into the ACTIVE model
 * slot once a newer load owns it — the same contract `loadFromCache` upholds
 * (see `useIfcCache.staleness.test.tsx`, PR #2301). `useIfcCache.ts`'s own
 * `isStale` doc claims this IS the same contract ("Same contract as
 * `loadFromServer`'s (useIfcServer.ts:120)"), but until this fix that claim
 * was aspirational: `loadFromServer`'s streaming batch callback (the
 * `onBatch` argument to `client.parseParquetStream`) wrote `setProgress` and
 * `setGeometryResult` on EVERY batch without ever re-checking `isStale`,
 * unlike `useIfcCache`'s per-chunk guard in its streaming loop.
 *
 * The window is real: `client.parseParquetStream` is one long-running await
 * that invokes `onBatch` once per batch as data arrives. A user who opens
 * file B while file A is still streaming has A's later batches land in B's
 * slot — the new model blanks and then repopulates with the previous file's
 * geometry.
 *
 * A single-batch fixture cannot observe this: the whole defect is about what
 * happens AFTER supersession, so this fixture delivers two batches with a
 * controllable gap between them and flips `isStale` in that gap.
 */

import '@/test/setup-dom.js';

// Must run BEFORE the static import graph below evaluates: `ifcConfig.ts`
// reads `import.meta.env` at module top level (via the test harness's
// `??=` prelude, see `vite-module-hooks-impl.mjs`), so `SERVER_URL` is
// already captured as `''` by the time any later statement in THIS file
// runs. A dynamic `import()` after this assignment is what defers module
// evaluation past it.
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test',
  DEV: false,
  PROD: false,
  // Localhost so `isServerReachable` (useIfcServer.ts) treats it as
  // same-origin-safe under happy-dom's default `http://localhost/` location.
  VITE_IFC_SERVER_URL: 'http://localhost:9999',
  VITE_USE_SERVER: 'true',
};

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  IfcServerClient,
  type ParquetBatch,
  type ParquetStreamResult,
  type MeshData as ServerMeshData,
  type HealthResponse,
} from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';

// Deferred until AFTER __VITE_ENV__ is seeded above — see comment there.
const { useIfcServer } = await import('./useIfcServer.js');

// ─── Fixture: two streamed batches ────────────────────────────────────────

function rawMesh(expressId: number): ServerMeshData {
  return {
    express_id: expressId,
    ifc_type: 'IFCWALL',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.25, 0.125, 1],
  };
}

const BATCH_1: ParquetBatch = { meshes: [rawMesh(1)], batch_number: 1, decode_time_ms: 0 };
const BATCH_2: ParquetBatch = { meshes: [rawMesh(2)], batch_number: 2, decode_time_ms: 0 };

const STREAM_RESULT: ParquetStreamResult = {
  cache_key: 'test-cache-key',
  total_meshes: 2,
  stats: {
    total_meshes: 2,
    total_vertices: 6,
    total_triangles: 2,
    parse_time_ms: 1,
    geometry_time_ms: 1,
    total_time_ms: 2,
    from_cache: false,
  },
  metadata: {
    schema_version: 'IFC4',
    entity_count: 2,
    geometry_entity_count: 2,
    coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false },
  },
};

/** A fake ArrayBuffer that reports a size over the streaming threshold
 * (150MB) without allocating real memory — `loadFromServer` only ever
 * reads `buffer.byteLength`. */
const HUGE_BUFFER = { byteLength: 200 * 1024 * 1024 } as ArrayBuffer;

/** Gate controlling when batch 2 is delivered, so the test can flip
 * `isStale` in the window between the two batches deterministically. */
let releaseBatch2: () => void;
let batch2Gate: Promise<void>;
let batchesDelivered: number;

function resetGate() {
  batchesDelivered = 0;
  batch2Gate = new Promise<void>((resolve) => {
    releaseBatch2 = resolve;
  });
}

const originalHealth = IfcServerClient.prototype.health;
const originalIsParquetSupported = IfcServerClient.prototype.isParquetSupported;
const originalParseParquetStream = IfcServerClient.prototype.parseParquetStream;
const originalFetchDataModel = IfcServerClient.prototype.fetchDataModel;

beforeEach(() => {
  resetGate();
  IfcServerClient.prototype.health = async (): Promise<HealthResponse> =>
    ({ status: 'ok' }) as HealthResponse;
  IfcServerClient.prototype.isParquetSupported = async () => true;
  IfcServerClient.prototype.parseParquetStream = async function (
    _file: File | ArrayBuffer,
    onBatch: (batch: ParquetBatch) => void,
  ): Promise<ParquetStreamResult> {
    onBatch(BATCH_1);
    batchesDelivered = 1;
    await batch2Gate;
    onBatch(BATCH_2);
    batchesDelivered = 2;
    return STREAM_RESULT;
  };
  // The background data-model fetch (fire-and-forget after geometry is set)
  // is not what this test observes — without a mock it hits a real network
  // socket that retries for tens of seconds against nothing listening on
  // :9999. `null` takes the same short-circuit `loadFromServer` already
  // handles for "no data model available".
  IfcServerClient.prototype.fetchDataModel = async () => null;
  useViewerStore.setState({ progress: null, geometryResult: null, ifcDataStore: null });
});

afterEach(() => {
  IfcServerClient.prototype.health = originalHealth;
  IfcServerClient.prototype.isParquetSupported = originalIsParquetSupported;
  IfcServerClient.prototype.parseParquetStream = originalParseParquetStream;
  IfcServerClient.prototype.fetchDataModel = originalFetchDataModel;
  useViewerStore.setState({ progress: null, geometryResult: null, ifcDataStore: null });
});

// ─── Harness: the real hook, rendered ─────────────────────────────────────

type LoadFromServer = ReturnType<typeof useIfcServer>['loadFromServer'];

let root: Root | null = null;
let loadFromServer: LoadFromServer | null = null;

function Probe() {
  loadFromServer = useIfcServer().loadFromServer;
  return null;
}

function snapshot() {
  const s = useViewerStore.getState();
  return {
    geometryMeshIds: (s.geometryResult?.meshes ?? []).map((m) => m.expressId),
    progressPhase: s.progress?.phase,
  };
}

describe('loadFromServer — a superseded stream must not paint into the active slot', () => {
  beforeEach(async () => {
    loadFromServer = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    assert.ok(loadFromServer, 'the hook must expose loadFromServer');
  });

  afterEach(async () => {
    const current = root;
    root = null;
    if (current) await act(async () => current.unmount());
  });

  it('supersession BETWEEN streaming batches leaves the second batch unpainted', async () => {
    let stale = false;
    const resultPromise = loadFromServer!(
      new File(['x'], 'model.ifc'),
      HUGE_BUFFER,
      () => stale,
    );

    // Let batch 1 land. `loadFromServer` awaits `isServerAvailable` (which
    // awaits `client.health()`) and `client.isParquetSupported()` before it
    // ever reaches `parseParquetStream`, so this needs to drain more than a
    // couple of microtask ticks — poll with a generous bound instead of
    // guessing a tick count.
    for (let i = 0; i < 50 && batchesDelivered < 1; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(batchesDelivered, 1, 'batch 1 must have been delivered before we flip staleness');
    const afterBatch1 = snapshot();
    assert.deepEqual(
      afterBatch1.geometryMeshIds,
      [1],
      'pre-supersession: batch 1 must have painted normally',
    );

    // Now supersede this load and release batch 2.
    stale = true;
    releaseBatch2();
    const result = await resultPromise;

    assert.equal(result, false, 'a superseded streaming load must not report success');
    const after = snapshot();
    assert.deepEqual(
      after.geometryMeshIds,
      [1],
      'batch 2 must NOT be painted after supersession — only the pre-supersession mesh may land',
    );
    assert.notEqual(
      after.progressPhase,
      'Streaming batch 2',
      'no progress line for the post-supersession batch may be posted',
    );
    assert.notEqual(
      after.progressPhase,
      'Complete',
      'the trailing Complete write must not fire for a superseded load',
    );
  });

  it('control: a NON-stale load still paints both batches', async () => {
    // No staleness to wait on here — release batch 2 immediately so the
    // mocked stream completes like an ordinary uninterrupted load.
    releaseBatch2();
    const result = await loadFromServer!(new File(['x'], 'model.ifc'), HUGE_BUFFER, () => false);
    assert.equal(result, true, 'a non-stale load must report success');
    const after = snapshot();
    assert.deepEqual(
      after.geometryMeshIds.sort((a, b) => a - b),
      [1, 2],
      'a non-stale load must still paint every batch — the fix must not disable streaming',
    );
  });
});
