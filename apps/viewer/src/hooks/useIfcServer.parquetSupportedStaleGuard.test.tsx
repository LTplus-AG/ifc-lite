/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadFromServer` re-checks `isStale` after every awaited network round
 * trip EXCEPT one: `await client.isParquetSupported()` — the capability
 * check that decides which of the three parse paths (streaming Parquet,
 * non-streaming Parquet, JSON) to take. Without a re-check immediately
 * after it, a load superseded while that single await was in flight still
 * goes on to issue the (now-pointless) `parseParquet`/`parse`/
 * `parseParquetStream` request — the downstream guards on THOSE awaits
 * only stop the write into the store, they don't stop the wasted request
 * from ever being made.
 *
 * This fixture blocks `isParquetSupported` on a manually-controlled gate,
 * waits on a signal that it was actually called (not a tick count), flips
 * `isStale` while it's still pending, then releases it — and asserts the
 * downstream parse call never happens at all.
 */

(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test',
  DEV: false,
  PROD: false,
  VITE_IFC_SERVER_URL: 'http://localhost:9999',
  VITE_USE_SERVER: 'true',
};

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  IfcServerClient,
  type ParquetParseResponse,
  type HealthResponse,
} from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';

// Deferred until AFTER __VITE_ENV__ is seeded above.
const { useIfcServer } = await import('./useIfcServer.js');

// ─── Fixture ────────────────────────────────────────────────────────────

/** Small buffer — stays on the non-streaming Parquet path regardless of
 * `parquetSupported`, so this test isolates the `isParquetSupported`
 * guard from the (already-guarded) streaming-batch path. */
const SMALL_BUFFER = { byteLength: 1024 } as ArrayBuffer;

const PARQUET_RESULT: ParquetParseResponse = {
  meshes: [
    {
      express_id: 1,
      ifc_type: 'IFCWALL',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [0.5, 0.25, 0.125, 1],
    },
  ],
  cache_key: 'test-cache-key',
  metadata: {
    schema_version: 'IFC4',
    entity_count: 1,
    geometry_entity_count: 1,
    coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false },
  },
  stats: {
    total_meshes: 1,
    total_vertices: 3,
    total_triangles: 1,
    parse_time_ms: 1,
    geometry_time_ms: 1,
    total_time_ms: 2,
    from_cache: false,
  },
  parquet_stats: {
    payload_size: 0,
    decode_time_ms: 0,
  },
};

/** Gate controlling when `isParquetSupported` resolves, so the test can
 * flip `isStale` while it's pending, deterministically. */
let releaseIsParquetSupported: (value: boolean) => void;
let isParquetSupportedGate: Promise<boolean>;
/** Resolves once `isParquetSupported` has actually been CALLED — a signal,
 * not a tick count, per the interleaving requirement above. */
let isParquetSupportedCalled: Promise<void>;
let signalIsParquetSupportedCalled: () => void;
let parseParquetCallCount: number;

function resetGates() {
  isParquetSupportedGate = new Promise<boolean>((resolve) => {
    releaseIsParquetSupported = resolve;
  });
  isParquetSupportedCalled = new Promise<void>((resolve) => {
    signalIsParquetSupportedCalled = resolve;
  });
  parseParquetCallCount = 0;
}

const originalHealth = IfcServerClient.prototype.health;
const originalIsParquetSupported = IfcServerClient.prototype.isParquetSupported;
const originalParseParquet = IfcServerClient.prototype.parseParquet;
const originalFetchDataModel = IfcServerClient.prototype.fetchDataModel;

beforeEach(() => {
  resetGates();
  IfcServerClient.prototype.health = async (): Promise<HealthResponse> =>
    ({ status: 'ok' }) as HealthResponse;
  IfcServerClient.prototype.isParquetSupported = async () => {
    signalIsParquetSupportedCalled();
    return isParquetSupportedGate;
  };
  IfcServerClient.prototype.parseParquet = async (): Promise<ParquetParseResponse> => {
    parseParquetCallCount++;
    return PARQUET_RESULT;
  };
  // Fire-and-forget background fetch — not observed by this test.
  IfcServerClient.prototype.fetchDataModel = async () => null;
  useViewerStore.setState({ progress: null, geometryResult: null, ifcDataStore: null });
});

afterEach(() => {
  IfcServerClient.prototype.health = originalHealth;
  IfcServerClient.prototype.isParquetSupported = originalIsParquetSupported;
  IfcServerClient.prototype.parseParquet = originalParseParquet;
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

describe('loadFromServer — supersession during the isParquetSupported await', () => {
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

  it('a load superseded while isParquetSupported is in flight must not go on to call parseParquet', async () => {
    let stale = false;
    const resultPromise = loadFromServer!(
      new File(['x'], 'model.ifc'),
      SMALL_BUFFER,
      () => stale,
    );

    // Wait on the SIGNAL that isParquetSupported was called, not a tick
    // count — the intervening isServerAvailable/health await means a fixed
    // number of microtask ticks is not a reliable proxy for "we're now
    // inside the isParquetSupported call".
    await isParquetSupportedCalled;

    // Supersede this load while isParquetSupported is still pending, then
    // let it resolve.
    stale = true;
    releaseIsParquetSupported(true);

    const result = await resultPromise;

    assert.equal(result, false, 'a superseded load must not report success');
    assert.equal(
      parseParquetCallCount,
      0,
      'a load already known to be stale right after isParquetSupported resolves must not ' +
        'go on to issue the parseParquet request at all',
    );
  });

  it('control: a NON-stale load still proceeds to parseParquet and paints geometry', async () => {
    const resultPromise = loadFromServer!(new File(['x'], 'model.ifc'), SMALL_BUFFER, () => false);
    await isParquetSupportedCalled;
    releaseIsParquetSupported(true);

    const result = await resultPromise;

    assert.equal(result, true, 'a non-stale load must report success');
    assert.equal(parseParquetCallCount, 1, 'a non-stale load must still reach parseParquet');
    const meshIds = (useViewerStore.getState().geometryResult?.meshes ?? []).map((m) => m.expressId);
    assert.deepEqual(meshIds, [1], 'a non-stale load must still paint its geometry');
  });
});
