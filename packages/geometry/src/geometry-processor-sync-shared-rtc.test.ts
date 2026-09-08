/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const buildPrePassOnce = vi.fn();
  const processGeometryBatch = vi.fn();
  const clearPrePassCache = vi.fn();

  class MockIfcAPI {
    buildPrePassOnce(data: Uint8Array) {
      return buildPrePassOnce(data);
    }

    processGeometryBatch(
      data: Uint8Array,
      jobsFlat: Uint32Array,
      unitScale: number,
      rtcX: number,
      rtcY: number,
      rtcZ: number,
      needsShift: boolean,
      voidKeys: Uint32Array,
      voidCounts: Uint32Array,
      voidValues: Uint32Array,
      styleIds: Uint32Array,
      styleColors: Uint8Array,
    ) {
      return processGeometryBatch(
        data,
        jobsFlat,
        unitScale,
        rtcX,
        rtcY,
        rtcZ,
        needsShift,
        voidKeys,
        voidCounts,
        voidValues,
        styleIds,
        styleColors,
      );
    }

    clearPrePassCache() {
      return clearPrePassCache();
    }
  }

  return {
    init: vi.fn(async () => undefined),
    buildPrePassOnce,
    processGeometryBatch,
    clearPrePassCache,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

// The synchronous (<2MB) WASM mesh path (`collectMeshesViaPrePass`, reached
// via `processAdaptive`) must honour a caller-supplied federation
// `sharedRtcOffset` the same way `geometry-parallel.ts`'s `useSharedRtc`
// logic and the streaming path do — a small federated model must render at
// the shared origin, not its own per-model detected RTC offset.
describe('GeometryProcessor sync path (<2MB) sharedRtcOffset override', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.buildPrePassOnce.mockReset();
    wasmMocks.processGeometryBatch.mockReset();
    wasmMocks.clearPrePassCache.mockReset();
  });

  it('uses the caller-supplied sharedRtcOffset instead of the model-detected rtcOffset', async () => {
    wasmMocks.buildPrePassOnce.mockReturnValue({
      jobs: new Uint32Array([11, 0, 42]),
      totalJobs: 1,
      unitScale: 1,
      rtcOffset: new Float64Array([10, 20, 30]),
      // false on purpose. A caller-supplied shared offset must FORCE
      // needsShift true, and while the mock reports true this assertion
      // holds whether or not the fix does that -- dropping `useShared ?
      // true :` from applyPrePassMetadata leaves the test green and ships
      // half the fix unguarded.
      needsShift: false,
      buildingRotation: 0,
      voidKeys: new Uint32Array(),
      voidCounts: new Uint32Array(),
      voidValues: new Uint32Array(),
      styleIds: new Uint32Array(),
      styleColors: new Uint8Array(),
    });

    wasmMocks.processGeometryBatch.mockReturnValue({
      length: 0,
      get: () => undefined,
      free: vi.fn(),
    });

    const geometry = new GeometryProcessor();
    const buffer = new Uint8Array([65, 66, 67]);

    for await (const _event of geometry.processAdaptive(buffer, {
      sharedRtcOffset: { x: 100, y: 200, z: 300 },
    })) {
      // Drain the generator; assertions are on the mock call args below.
    }

    expect(wasmMocks.processGeometryBatch).toHaveBeenCalledTimes(1);
    const call = wasmMocks.processGeometryBatch.mock.calls[0];
    const [, , , rtcX, rtcY, rtcZ, needsShift] = call;
    expect(rtcX).toBe(100);
    expect(rtcY).toBe(200);
    expect(rtcZ).toBe(300);
    expect(needsShift).toBe(true);
  });
});
