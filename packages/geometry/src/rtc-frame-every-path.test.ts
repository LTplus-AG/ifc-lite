/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * All three WASM mesh paths resolve the RTC frame the same way (#4611).
 *
 * The federation-override rule was written out once per path — the sync path's
 * `applyPrePassMetadata`, the streaming path's `processStreamingBytes` (both in
 * index.ts) and `sendStreamStartIfReady` in geometry-parallel.ts. Nothing
 * compared them, so one could have been changed alone and the same model would
 * have rendered at two different origins depending on its size and on whether
 * the browser has SharedArrayBuffer.
 *
 * This file drives each path with the same pre-pass answer and the same
 * federation offset and asserts they agree, which is the thing the shared
 * `resolveRtcFrame` buys. Mutation: on origin/main, drop the `useSharedRtc ?
 * true :` from geometry-parallel.ts's `effectiveNeedsShift` (or the `?? 0`
 * fallbacks from `applyPrePassMetadata`) and only that path's expectation goes
 * red while the other two stay green — exactly the drift that cannot be
 * expressed once the rule has one home.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const buildPrePassOnce = vi.fn();
  const processGeometryBatch = vi.fn();
  const clearPrePassCache = vi.fn();

  class MockIfcAPI {
    buildPrePassOnce(data: Uint8Array) {
      return buildPrePassOnce(data);
    }

    processGeometryBatch(...args: unknown[]) {
      return processGeometryBatch(...args);
    }

    clearPrePassCache() {
      return clearPrePassCache();
    }
  }

  return { init: vi.fn(async () => undefined), buildPrePassOnce, processGeometryBatch, clearPrePassCache, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor, type StreamingGeometryEvent } from './index.js';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';

/** The offset THIS model's pre-pass detected for itself. */
const DETECTED = [10, 20, 30] as const;
/** The federation origin the caller wants every model to share. */
const SHARED = { x: 100, y: 200, z: 300 };

/** What every path must end up subtracting, and whether it subtracts at all. */
interface Frame {
  x: number;
  y: number;
  z: number;
  needsShift: boolean;
}

function prePassResult(needsShift: boolean) {
  return {
    // One job, so the batch path actually runs and reports its arguments.
    jobs: new Uint32Array([11, 0, 42]),
    totalJobs: 1,
    unitScale: 1,
    rtcOffset: new Float64Array(DETECTED),
    needsShift,
    buildingRotation: 0,
    voidKeys: new Uint32Array(),
    voidCounts: new Uint32Array(),
    voidValues: new Uint32Array(),
    styleIds: new Uint32Array(),
    styleColors: new Uint8Array(),
  };
}

function emptyMeshCollection() {
  return { length: 0, get: () => undefined, free: vi.fn() };
}

/** Frame the SYNC (<2 MB) path handed to `processGeometryBatch`. */
async function frameFromSyncPath(
  detectedNeedsShift: boolean,
  sharedRtcOffset?: { x: number; y: number; z: number },
): Promise<Frame> {
  wasmMocks.buildPrePassOnce.mockReturnValue(prePassResult(detectedNeedsShift));
  wasmMocks.processGeometryBatch.mockReturnValue(emptyMeshCollection());

  const geometry = new GeometryProcessor();
  for await (const _event of geometry.processAdaptive(new Uint8Array([65, 66, 67]), { sharedRtcOffset })) {
    // Drain; the assertion is on the mock's arguments.
  }

  expect(wasmMocks.processGeometryBatch).toHaveBeenCalled();
  const [, , , x, y, z, needsShift] = wasmMocks.processGeometryBatch.mock.calls[0];
  return { x, y, z, needsShift };
}

/** Frame the STREAMING path handed to `processGeometryBatch`, and announced. */
async function frameFromStreamingPath(
  detectedNeedsShift: boolean,
  sharedRtcOffset?: { x: number; y: number; z: number },
): Promise<{ applied: Frame; announced: Frame }> {
  wasmMocks.buildPrePassOnce.mockReturnValue(prePassResult(detectedNeedsShift));
  wasmMocks.processGeometryBatch.mockReturnValue(emptyMeshCollection());

  const geometry = new GeometryProcessor();
  const events: StreamingGeometryEvent[] = [];
  for await (const event of geometry.processStreaming(new Uint8Array([65, 66, 67]), undefined, 25, sharedRtcOffset)) {
    events.push(event);
  }

  expect(wasmMocks.processGeometryBatch).toHaveBeenCalled();
  const [, , , x, y, z, needsShift] = wasmMocks.processGeometryBatch.mock.calls[0];
  const announcement = events.find((e) => e.type === 'rtcOffset');
  if (announcement?.type !== 'rtcOffset') throw new Error('streaming path announced no rtcOffset event');
  return {
    applied: { x, y, z, needsShift },
    announced: { ...announcement.rtcOffset, needsShift: announcement.hasRtc },
  };
}

// ── Worker-pool fixture ──

class FakeWorker {
  postMessage: (msg: unknown) => void;
  terminate = vi.fn();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(onPost: (self: FakeWorker, msg: unknown) => void) {
    this.postMessage = vi.fn((msg: unknown) => onPost(this, msg));
  }
}

let createdWorkers: FakeWorker[];
let originalWorker: unknown;
let streamStartMessages: Array<Record<string, unknown>>;

beforeEach(() => {
  createdWorkers = [];
  streamStartMessages = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  wasmMocks.init.mockClear();
  wasmMocks.buildPrePassOnce.mockReset();
  wasmMocks.processGeometryBatch.mockReset();
  wasmMocks.clearPrePassCache.mockReset();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

/**
 * Worker #0 is the one-strong process pool, worker #1 the pre-pass worker.
 * The pre-pass worker replies to `prepass-streaming` with the same meta the
 * other two paths get from `buildPrePassOnce`, then completes with no jobs so
 * the generator settles. Worker #0 records the `stream-start` it is sent (the
 * frame the pool will mesh in) and answers `stream-end` with `complete`.
 */
function installFakeWorkers(detectedNeedsShift: boolean): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
    const index = createdWorkers.length;
    const worker = new FakeWorker((self, msg) => {
      const m = msg as { type?: string };
      if (index === 0 && m.type === 'stream-start') {
        streamStartMessages.push(m as Record<string, unknown>);
        return;
      }
      if (index === 0 && m.type === 'stream-end') {
        queueMicrotask(() => {
          self.onmessage?.({
            data: {
              type: 'batch',
              meshes: [{
                expressId: 11,
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
                indices: new Uint32Array([0, 1, 2]),
                color: [1, 1, 1, 1],
              }],
            },
          });
          self.onmessage?.({ data: { type: 'complete', totalMeshes: 1 } });
        });
        return;
      }
      if (index === 1 && m.type === 'prepass-streaming') {
        queueMicrotask(() => {
          self.onmessage?.({
            data: {
              type: 'prepass-stream',
              event: {
                type: 'meta',
                unitScale: 1,
                rtcOffset: new Float64Array(DETECTED),
                needsShift: detectedNeedsShift,
              },
            },
          });
          self.onmessage?.({ data: { type: 'prepass-stream', event: { type: 'complete', totalJobs: 0 } } });
        });
      }
    });
    createdWorkers.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

/** Frame the WORKER POOL was started in, and the one it announced. */
async function frameFromParallelPath(
  detectedNeedsShift: boolean,
  sharedRtcOffset?: { x: number; y: number; z: number },
): Promise<{ applied: Frame; announced: Frame }> {
  installFakeWorkers(detectedNeedsShift);
  const events: StreamingGeometryEvent[] = [];
  const gen = processParallel(new Uint8Array(16), new CoordinateHandler(), sharedRtcOffset, undefined, {
    workerCountOverride: 1,
  });
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), 2_000).unref?.();
  });
  await Promise.race([
    (async () => {
      for await (const event of gen) events.push(event);
    })(),
    deadline,
  ]);

  expect(streamStartMessages).toHaveLength(1);
  const start = streamStartMessages[0] as { rtcX: number; rtcY: number; rtcZ: number; needsShift: boolean };
  const announcement = events.find((e) => e.type === 'rtcOffset');
  if (announcement?.type !== 'rtcOffset') throw new Error('parallel path announced no rtcOffset event');
  const batch = events.find((e) => e.type === 'batch');
  if (batch?.type !== 'batch') throw new Error('parallel path emitted no mesh batch');
  expect(batch.coordinateInfo?.originShift).toEqual({ x: 0, y: 0, z: 0 });
  expect(batch.coordinateInfo?.wasmRtcOffset).toEqual(
    start.needsShift ? { x: start.rtcX, y: start.rtcY, z: start.rtcZ } : undefined,
  );
  return {
    applied: { x: start.rtcX, y: start.rtcY, z: start.rtcZ, needsShift: start.needsShift },
    announced: { ...announcement.rtcOffset, needsShift: announcement.hasRtc },
  };
}

describe('every WASM mesh path resolves the same RTC frame', () => {
  it('applies the federation offset, and forces the shift, on all three paths', async () => {
    // `needsShift: false` from the pre-pass on purpose: this is the small
    // federated model whose own coordinates are already near the origin. Any
    // path that honours its detected answer renders it one federation offset
    // away from its neighbours.
    const expected: Frame = { x: SHARED.x, y: SHARED.y, z: SHARED.z, needsShift: true };

    expect(await frameFromSyncPath(false, SHARED)).toEqual(expected);

    const streaming = await frameFromStreamingPath(false, SHARED);
    expect(streaming.applied).toEqual(expected);
    expect(streaming.announced).toEqual(expected);

    const parallel = await frameFromParallelPath(false, SHARED);
    expect(parallel.applied).toEqual(expected);
    expect(parallel.announced).toEqual(expected);
  });

  it('falls back to the model-detected offset, on all three paths, with no federation offset', async () => {
    const expected: Frame = { x: DETECTED[0], y: DETECTED[1], z: DETECTED[2], needsShift: true };

    expect(await frameFromSyncPath(true, undefined)).toEqual(expected);

    const streaming = await frameFromStreamingPath(true, undefined);
    expect(streaming.applied).toEqual(expected);
    expect(streaming.announced).toEqual(expected);

    const parallel = await frameFromParallelPath(true, undefined);
    expect(parallel.applied).toEqual(expected);
    expect(parallel.announced).toEqual(expected);
  });
});
