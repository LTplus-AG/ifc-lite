/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5582, synchronous (<2MB) WASM mesh path: `buildPrePassOnce` returns
 * `styleFinishes` beside `styleColors`, but `processGeometryBatch` takes only
 * the colours, so `GeometryProcessor` must install the finishes on the SAME
 * IfcAPI with `setStyleFinishes` before the batch, and the batch's
 * `MeshDataJs.metallic/roughness` must reach `MeshData.material`. The wasm is
 * mocked: this pins the JS wiring; the Rust join (finish by
 * `geometry_item_id`) is pinned in `style_finishes_tests.rs`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const calls: string[] = [];
  const parallel = vi.fn(async function* (..._args: unknown[]) { yield* []; });
  const buildPrePassOnce = vi.fn();
  const setSkipVoids = vi.fn();
  const setStyleFinishes = vi.fn((_ids: Uint32Array, _finishes: Float32Array) => {
    calls.push('setStyleFinishes');
  });
  const processGeometryBatch = vi.fn((..._args: unknown[]) => {
    calls.push('processGeometryBatch');
    return {
      length: 1,
      get: () => ({
        expressId: 11,
        ifcType: 'IfcWindow',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: new Float32Array([0.8, 0.8, 0.85, 1]),
        metallic: 1,
        roughness: 0.125,
        free: vi.fn(),
      }),
      free: vi.fn(),
    };
  });
  class MockIfcAPI {
    buildPrePassOnce = buildPrePassOnce;
    setSkipVoids = setSkipVoids;
    setStyleFinishes = setStyleFinishes;
    processGeometryBatch = processGeometryBatch;
    clearPrePassCache = vi.fn();
    free = vi.fn();
  }
  return { init: vi.fn(async () => undefined), parallel, calls, buildPrePassOnce, setSkipVoids, setStyleFinishes, processGeometryBatch, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  ENGINE_BINARY_URL: null,
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

vi.mock('./geometry-parallel.js', () => ({ processParallel: wasmMocks.parallel }));

import { GeometryProcessor } from './index.js';

function prePass(styleFinishes?: Float32Array) {
  return {
    jobs: new Uint32Array([11, 0, 3]),
    totalJobs: 1,
    unitScale: 1,
    rtcOffset: new Float64Array([0, 0, 0]),
    needsShift: false,
    buildingRotation: 0,
    voidKeys: new Uint32Array(),
    voidCounts: new Uint32Array(),
    voidValues: new Uint32Array(),
    styleIds: new Uint32Array([10, 20]),
    styleColors: new Uint8Array(8),
    ...(styleFinishes ? { styleFinishes } : {}),
  };
}

async function load() {
  const events = [];
  for await (const event of new GeometryProcessor().processAdaptive(new Uint8Array([65, 66, 67]))) {
    events.push(event);
  }
  return events;
}

describe('GeometryProcessor sync path #5582 style finishes', () => {
  beforeEach(() => {
    wasmMocks.calls.length = 0;
    wasmMocks.setSkipVoids.mockClear();
    wasmMocks.buildPrePassOnce.mockReset();
    wasmMocks.setStyleFinishes.mockClear();
    wasmMocks.processGeometryBatch.mockClear();
  });

  it('installs the prepass styleFinishes before the batch and surfaces the mesh finish as MeshData.material', async () => {
    const pre = prePass(new Float32Array([1, 0.125, Number.NaN, 0.75]));
    wasmMocks.buildPrePassOnce.mockReturnValue(pre);

    const events = await load();

    expect(wasmMocks.setStyleFinishes).toHaveBeenCalledTimes(1);
    const [ids, finishes] = wasmMocks.setStyleFinishes.mock.calls[0];
    expect(ids).toBe(pre.styleIds);
    expect(finishes).toBe(pre.styleFinishes);
    expect(wasmMocks.calls).toEqual(['setStyleFinishes', 'processGeometryBatch']);
    // The batch runs against the same style wire the finishes were set for.
    expect(wasmMocks.processGeometryBatch.mock.calls[0][10]).toBe(pre.styleIds);

    const mesh = events.flatMap((e) => (e.type === 'batch' ? e.meshes : []))[0];
    expect(mesh?.material).toEqual({ metallic: 1, roughness: 0.125 });
  });

  it('sends nothing when the prepass carries no styleFinishes (older wasm)', async () => {
    wasmMocks.buildPrePassOnce.mockReturnValue(prePass());

    await load();

    expect(wasmMocks.processGeometryBatch).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setStyleFinishes).not.toHaveBeenCalled();
  });
});

// #8875: prove the public processor passes gross mode before any mesh batch.
it('sets skipVoids on the actual bridge before adaptive small-file geometry', async () => {
  wasmMocks.buildPrePassOnce.mockReturnValue(prePass());
  wasmMocks.setSkipVoids.mockClear();
  wasmMocks.processGeometryBatch.mockClear();
  const processor = new GeometryProcessor({ skipVoids: true });
  try {
    for await (const _event of processor.processAdaptive(new Uint8Array([65]))) { /* drain */ }
    expect(wasmMocks.setSkipVoids).toHaveBeenCalledWith(true);
    expect(wasmMocks.setSkipVoids.mock.invocationCallOrder[0])
      .toBeLessThan(wasmMocks.processGeometryBatch.mock.invocationCallOrder[0]);
  } finally { processor.dispose(); }
});

// #8875: the adaptive large-file route must forward the same cut policy to its pool.
it('forwards skipVoids through adaptive worker-pool selection', async () => {
  vi.stubGlobal('Worker', class {});
  vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
  const processor = new GeometryProcessor({ skipVoids: true });
  try {
    for await (const _event of processor.processAdaptive(new Uint8Array([65]), { sizeThreshold: 0 })) { /* drain */ }
    expect(wasmMocks.parallel).toHaveBeenCalled();
    expect(wasmMocks.parallel.mock.calls.at(-1)?.[4]).toMatchObject({ skipVoids: true });
  } finally { processor.dispose(); vi.unstubAllGlobals(); }
});
