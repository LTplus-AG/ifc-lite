/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const parseMeshesAsync = vi.fn();
  const parseMeshesInstancedAsync = vi.fn();
  const buildPrePassOnce = vi.fn();
  const processGeometryBatch = vi.fn();
  const processInstancedGeometryBatch = vi.fn();

  class MockIfcAPI {
    parseMeshesAsync(content: string, options: unknown) {
      return parseMeshesAsync(content, options);
    }

    parseMeshesInstancedAsync(content: string, options: unknown) {
      return parseMeshesInstancedAsync(content, options);
    }

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

    processInstancedGeometryBatch(
      data: Uint8Array,
      jobsFlat: Uint32Array,
      unitScale: number,
      rtcX: number,
      rtcY: number,
      rtcZ: number,
      needsShift: boolean,
      styleIds: Uint32Array,
      styleColors: Uint8Array,
    ) {
      return processInstancedGeometryBatch(
        data,
        jobsFlat,
        unitScale,
        rtcX,
        rtcY,
        rtcZ,
        needsShift,
        styleIds,
        styleColors,
      );
    }
  }

  return {
    init: vi.fn(async () => undefined),
    parseMeshesAsync,
    parseMeshesInstancedAsync,
    buildPrePassOnce,
    processGeometryBatch,
    processInstancedGeometryBatch,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

describe('GeometryProcessor byte streaming fallback', () => {
  const originalThreshold = (GeometryProcessor as any).largeFileByteStreamingThreshold;

  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.parseMeshesAsync.mockReset();
    wasmMocks.parseMeshesInstancedAsync.mockReset();
    wasmMocks.buildPrePassOnce.mockReset();
    wasmMocks.processGeometryBatch.mockReset();
    wasmMocks.processInstancedGeometryBatch.mockReset();
    (GeometryProcessor as any).largeFileByteStreamingThreshold = 1;
  });

  afterEach(() => {
    (GeometryProcessor as any).largeFileByteStreamingThreshold = originalThreshold;
  });

  it('uses byte-based prepass and batch processing for large files', async () => {
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

    expect(wasmMocks.parseMeshesAsync).not.toHaveBeenCalled();
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
    const overlappingInstancedStream = secondGeometry.processInstancedStreaming(buffer);
    await expect(overlappingInstancedStream.next()).rejects.toThrow(
      'GeometryProcessor processInstancedStreaming cannot start while processStreaming is still running.',
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

  it('uses byte-based instanced batch processing for large files', async () => {
    wasmMocks.buildPrePassOnce.mockReturnValue({
      jobs: new Uint32Array([21, 0, 84]),
      totalJobs: 1,
      unitScale: 1,
      rtcOffset: new Float64Array([0, 0, 0]),
      needsShift: false,
      buildingRotation: 0.25,
      voidKeys: new Uint32Array(),
      voidCounts: new Uint32Array(),
      voidValues: new Uint32Array(),
      styleIds: new Uint32Array([9]),
      styleColors: new Uint8Array([0, 255, 0, 255]),
    });

    const collectionFree = vi.fn();
    const instance = {
      expressId: 21,
      color: [0, 1, 0, 1],
    };

    wasmMocks.processInstancedGeometryBatch.mockReturnValue({
      length: 1,
      get(index: number) {
        if (index !== 0) return undefined;
        return {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          instance_count: 1,
          get_instance(instanceIndex: number) {
            return instanceIndex === 0 ? instance : undefined;
          },
        };
      },
      free: collectionFree,
    });

    const geometry = new GeometryProcessor();
    const buffer = new Uint8Array([65, 66, 67]);
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of geometry.processInstancedStreaming(buffer)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(wasmMocks.parseMeshesInstancedAsync).not.toHaveBeenCalled();
    expect(wasmMocks.buildPrePassOnce).toHaveBeenCalledWith(buffer);
    expect(wasmMocks.processInstancedGeometryBatch).toHaveBeenCalledTimes(1);
    expect(collectionFree).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'model-open',
      'batch',
      'complete',
    ]);

    const batchEvent = events.find((event) => event.type === 'batch');
    expect(batchEvent?.totalSoFar).toBe(1);
    expect((batchEvent?.coordinateInfo as { buildingRotation?: number })?.buildingRotation).toBe(0.25);

    const completeEvent = events.find((event) => event.type === 'complete');
    expect(completeEvent?.totalGeometries).toBe(1);
    expect(completeEvent?.totalInstances).toBe(1);
    expect((completeEvent?.coordinateInfo as { buildingRotation?: number })?.buildingRotation).toBe(0.25);
  });
});
