/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const buildPrePassOnce = vi.fn();
  const processGeometryBatch = vi.fn();

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
  }

  return {
    init: vi.fn(async () => undefined),
    buildPrePassOnce,
    processGeometryBatch,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

// `processStreaming()` always runs the byte-based prepass/batch path — it is
// not gated by file size (there is no "small file" alternative streaming
// path to fall back from). This suite mocks the WASM bridge and exercises
// `processStreaming()` directly to pin that behaviour: the byte prepass and
// batch-processing calls it makes, the event sequence it yields, and its
// WASM-handle `.free()` / re-entrancy discipline. It does NOT depend on
// `GeometryProcessor`'s private `largeFileByteStreamingThreshold` static
// (`index.ts`) — that field is never read by production code (see
// `processAdaptive`'s separate, locally-scoped `sizeThreshold`, which is the
// actual small/large-file gate, and only applies to `processAdaptive`, not
// `processStreaming`).
describe('GeometryProcessor byte streaming (processStreaming, mocked WASM)', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.buildPrePassOnce.mockReset();
    wasmMocks.processGeometryBatch.mockReset();
  });

  it('uses byte-based prepass and batch processing', async () => {
    wasmMocks.buildPrePassOnce.mockReturnValue({
      jobs: new Uint32Array([11, 0, 42]),
      totalJobs: 1,
      unitScale: 1,
      rtcOffset: new Float64Array([10, 20, 30]),
      needsShift: true,
      buildingRotation: 0.5,
      voidKeys: new Uint32Array(),
      voidCounts: new Uint32Array(),
      voidValues: new Uint32Array(),
      styleIds: new Uint32Array([7]),
      styleColors: new Uint8Array([255, 0, 0, 255]),
    });

    const meshFree = vi.fn();
    const collectionFree = vi.fn();

    wasmMocks.processGeometryBatch.mockReturnValue({
      length: 1,
      get(index: number) {
        if (index !== 0) return undefined;
        return {
          expressId: 11,
          ifcType: 'IfcWall',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          color: new Float32Array([1, 0, 0, 1]),
          free: meshFree,
        };
      },
      free: collectionFree,
    });

    const geometry = new GeometryProcessor();
    const buffer = new Uint8Array([65, 66, 67]);
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of geometry.processStreaming(buffer)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(wasmMocks.buildPrePassOnce).toHaveBeenCalledWith(buffer);
    expect(wasmMocks.processGeometryBatch).toHaveBeenCalledTimes(1);
    expect(meshFree).toHaveBeenCalledTimes(1);
    expect(collectionFree).toHaveBeenCalledTimes(1);

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'model-open',
      'rtcOffset',
      'batch',
      'complete',
    ]);

    const batchEvent = events.find((event) => event.type === 'batch');
    expect(batchEvent?.totalSoFar).toBe(1);
    expect((batchEvent?.coordinateInfo as { buildingRotation?: number })?.buildingRotation).toBe(0.5);

    const completeEvent = events.find((event) => event.type === 'complete');
    expect((completeEvent?.coordinateInfo as { buildingRotation?: number })?.buildingRotation).toBe(0.5);
  });

  it('rejects overlapping WASM streaming runs before re-entering the processor', async () => {
    const firstGeometry = new GeometryProcessor();
    const secondGeometry = new GeometryProcessor();
    const buffer = new Uint8Array([65, 66, 67]);

    const firstStream = firstGeometry.processStreaming(buffer);
    await expect(firstStream.next()).resolves.toMatchObject({
      value: { type: 'start' },
      done: false,
    });

    const overlappingStream = secondGeometry.processStreaming(buffer);
    await expect(overlappingStream.next()).rejects.toThrow(
      'GeometryProcessor processStreaming cannot start while processStreaming is still running.',
    );
    expect(wasmMocks.buildPrePassOnce).not.toHaveBeenCalled();

    await firstStream.return?.(undefined);

    const retryStream = secondGeometry.processStreaming(buffer);
    await expect(retryStream.next()).resolves.toMatchObject({
      value: { type: 'start' },
      done: false,
    });
    await retryStream.return?.(undefined);
  });
});
