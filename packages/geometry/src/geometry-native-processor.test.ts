/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GeometryProcessor.processStreaming` on the native (Tauri) branch.
 *
 * This is the route wired to `NativeBridge.processGeometryStreaming` — the one
 * bridge method whose `finally` runs its three `unlisten()` calls AFTER
 * `onComplete`, so it is the one that can reject for a load that fully
 * succeeded. It used to carry its own copy of the drain loop, untested; the
 * copy in `geometry-native.ts` had all the tests. It now delegates to
 * `streamNativeGeometry`, and these tests fail if that delegation is undone.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@ifc-lite/wasm', () => ({
  default: vi.fn(async () => undefined),
  IfcAPI: class {},
}));

const bridgeMocks = vi.hoisted(() => ({
  processGeometryStreaming: vi.fn(),
}));

vi.mock('./platform-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform-bridge.js')>();
  const bridge: import('./platform-bridge.js').IPlatformBridge = {
    init: async () => {},
    isInitialized: () => true,
    processGeometry: () => Promise.reject(new Error('not used by these tests')),
    processGeometryStreaming: (content, options) =>
      bridgeMocks.processGeometryStreaming(content, options),
    getApi: () => null,
  };
  return {
    ...actual,
    isTauri: () => true,
    createPlatformBridge: async () => bridge,
  };
});

import { GeometryProcessor } from './index.js';
import type { GeometryBatch, GeometryStats, StreamingOptions } from './platform-bridge.js';
import type { MeshData } from './types.js';
// The streaming event union is declared and exported by index.ts, not types.ts
// (geometry-native.ts and geometry-parallel.ts import it from there too).
import type { StreamingGeometryEvent } from './index.js';

const mesh = (expressId: number): MeshData => ({
  expressId,
  ifcType: 'IfcWall',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 0, 0, 1],
});

const batch = (expressId: number): GeometryBatch => ({
  meshes: [mesh(expressId)],
  progress: { processed: expressId, total: 2, currentType: 'IfcWall' },
});

const twoMeshStats = (): GeometryStats => ({
  totalMeshes: 2,
  totalVertices: 6,
  totalTriangles: 2,
  parseTimeMs: 0,
  geometryTimeMs: 0,
});

/** Drain, failing fast: the pre-fix failure mode for a bare rejection is a HANG. */
async function drainWithDeadline(
  gen: AsyncGenerator<StreamingGeometryEvent>,
  ms = 1_000,
): Promise<StreamingGeometryEvent[]> {
  const events: StreamingGeometryEvent[] = [];
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), ms).unref?.();
  });
  const drain = (async () => {
    for await (const event of gen) events.push(event);
    return events;
  })();
  await Promise.race([drain, deadline]);
  return events;
}

const streamOf = (processor: GeometryProcessor) =>
  drainWithDeadline(processor.processStreaming(new Uint8Array([65, 66, 67])));

describe('GeometryProcessor.processStreaming on the native branch', () => {
  it('delivers `complete` when the bridge rejects after completing (microtask)', async () => {
    bridgeMocks.processGeometryStreaming.mockImplementation(
      (_content: unknown, options: StreamingOptions) => {
        options.onBatch?.(batch(1));
        options.onBatch?.(batch(2));
        options.onComplete?.(twoMeshStats());
        return Promise.reject(new Error('post-complete teardown failure'));
      },
    );

    const events = await streamOf(new GeometryProcessor());
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'batch', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', totalMeshes: 2 });
  });

  it('delivers `complete` when the bridge rejects a macrotask after completing', async () => {
    bridgeMocks.processGeometryStreaming.mockImplementation(
      (_content: unknown, options: StreamingOptions) => {
        options.onBatch?.(batch(1));
        options.onBatch?.(batch(2));
        options.onComplete?.(twoMeshStats());
        return new Promise<GeometryStats>((_resolve, reject) => {
          setTimeout(() => reject(new Error('post-complete teardown failure')), 10).unref?.();
        });
      },
    );

    const events = await streamOf(new GeometryProcessor());
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'batch', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', totalMeshes: 2 });
  });

  it('surfaces a bare rejection instead of hanging', async () => {
    bridgeMocks.processGeometryStreaming.mockImplementation(() =>
      Promise.reject(new Error('native stream rejected before onError')),
    );

    await expect(streamOf(new GeometryProcessor())).rejects.toThrow(
      'native stream rejected before onError',
    );
  });

  it('throws rather than reporting `complete` for a stream that called onError', async () => {
    bridgeMocks.processGeometryStreaming.mockImplementation(
      (_content: unknown, options: StreamingOptions) =>
        new Promise<GeometryStats>((resolve) => {
          setTimeout(() => {
            options.onError?.(new Error('native geometry stream failed mid-load'));
            resolve(twoMeshStats());
          }, 0).unref?.();
        }),
    );

    await expect(streamOf(new GeometryProcessor())).rejects.toThrow(
      'native geometry stream failed mid-load',
    );
  });

  it('completes a clean successful load', async () => {
    bridgeMocks.processGeometryStreaming.mockImplementation(
      (_content: unknown, options: StreamingOptions) => {
        options.onBatch?.(batch(1));
        options.onComplete?.({ ...twoMeshStats(), totalMeshes: 1 });
        return Promise.resolve({ ...twoMeshStats(), totalMeshes: 1 });
      },
    );

    const events = await streamOf(new GeometryProcessor());
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', totalMeshes: 1 });
  });
});
