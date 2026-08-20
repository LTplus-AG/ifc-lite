/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Thin GPU-facing half of frame/pass timing (issue #2670 perf-verdict gate).
 * Everything with judgement — statistics, unit conversion, mode selection —
 * lives in `frame-timing.ts` / `frame-timing-stats.ts`, which are pure and
 * fully covered by synthetic-value tests. This file is deliberately as small
 * as it can be: it only creates the `GPUQuerySet`, writes `timestampWrites`
 * into pass descriptors, resolves the query set into a readback buffer, and
 * hands the raw nanosecond pairs to the pure aggregator. None of it runs in
 * this environment (`navigator.gpu` is absent here, so there is no test file
 * for this module — a mock `GPUDevice` would only prove the mock is
 * internally consistent, not that the real WebGPU calls are correct) and
 * none of it should be trusted without exercising it on a real
 * `'timestamp-query'`-capable adapter.
 *
 * OPT-IN, NOT WIRED BY DEFAULT: nothing in this codebase constructs a
 * `GpuFrameTimingRecorder` today. A caller enables it explicitly:
 *
 * ```ts
 * const recorder = GpuFrameTimingRecorder.create(device); // null if unsupported
 * if (recorder) {
 *   const pass = encoder.beginRenderPass({
 *     ...descriptor,
 *     timestampWrites: recorder.beginPass('main'),
 *   });
 *   // ...draw calls...
 *   pass.end();
 *   recorder.endFrame(encoder);
 *   device.queue.submit([encoder.finish()]);
 *   const samples = await recorder.readback(); // PassTimingSample[] | null
 * }
 * ```
 *
 * Measuring every frame changes what you're measuring (query resolution and
 * the readback `mapAsync` are not free), so a caller should sample
 * intermittently (e.g. every Nth frame) rather than every frame in a
 * shipped build — this module does not impose that policy, it only makes
 * one frame's measurement cheap and correct.
 */

import type { PassTimingSample } from './frame-timing.js';

/** Feature-detects `'timestamp-query'` on an already-created `GPUDevice`'s adapter features, without touching mode-decision logic (see `decideTimingMode` in `frame-timing.ts`, which consumes this boolean). */
export function hasTimestampQueryFeature(features: { has(name: string): boolean } | null | undefined): boolean {
  return features?.has('timestamp-query') ?? false;
}

const BYTES_PER_TIMESTAMP = 8; // GPUQuerySet resolves each timestamp query to one 64-bit (BigInt64) value.

/**
 * Byte size of the resolve/readback buffers needed for `passCount` passes —
 * 2 timestamp queries (begin + end) per pass, `BYTES_PER_TIMESTAMP` each.
 * Pure arithmetic, decidable without a device: extracted out of `create()`
 * so the sizing formula itself is unit-tested rather than only ever
 * exercised as a side effect of a real `device.createBuffer` call.
 */
export function queryBufferSizeBytes(passCount: number): number {
  return passCount * 2 * BYTES_PER_TIMESTAMP;
}

/**
 * Allocates the next pair of query-set write indices for one pass, or
 * `null` if `maxPasses` passes have already been begun this frame. Pure:
 * given the current cursor and the frame's pass budget, the next
 * (begin, end, cursor) triple — or exhaustion — is fully determined; no
 * `GPUQuerySet` is touched to decide it. Extracted out of
 * `GpuFrameTimingRecorder.beginPass` so this index bookkeeping (the part
 * most likely to hide an off-by-one — see the exhaustion boundary test) is
 * checked with synthetic cursor/maxPasses values instead of only ever
 * running inside a live recording session.
 */
export function allocatePassQueryIndices(
  nextQueryIndex: number,
  maxPasses: number,
): { beginningOfPassWriteIndex: number; endOfPassWriteIndex: number; nextQueryIndex: number } | null {
  if (nextQueryIndex + 1 >= maxPasses * 2) return null;
  return {
    beginningOfPassWriteIndex: nextQueryIndex,
    endOfPassWriteIndex: nextQueryIndex + 1,
    nextQueryIndex: nextQueryIndex + 2,
  };
}

/**
 * Pairs each recorded pass `label` (in recording order) with its
 * (start, end) nanosecond timestamps at `timestamps[i*2]` /
 * `timestamps[i*2+1]` — the layout `GpuFrameTimingRecorder` writes via
 * `timestampWrites`. Pure: given a labels array and a `BigInt64Array`, the
 * resulting `PassTimingSample[]` is fully determined; no `GPUBuffer`
 * mapping is involved. Extracted out of `readback()` so this pairing
 * arithmetic — the part that would silently mis-attribute a duration to
 * the wrong label on an off-by-one — is checked directly.
 *
 * `GpuFrameTimingRecorder.readback()` always calls this with
 * `timestamps.length === labels.length * 2` (it sizes the readback slice
 * from the same `nextQueryIndex` cursor that `beginPass` pushed each label
 * against — see `readback()`'s call site), so a short buffer cannot occur
 * on that path today. But this function is exported precisely so it can be
 * exercised standalone, and a caller passing a corrupted or hand-built
 * buffer must not get back a sample whose `startNs`/`endNs` is `undefined`
 * where the type says `bigint`: that silently propagates into
 * `frameTotalMs`/`passDurationsMs` (`frame-timing.ts`), which throws a
 * `TypeError` mixing `BigInt` and `undefined` for a one-short buffer, or
 * silently computes `NaN` for a two-short buffer — two different failure
 * shapes for what is really the same input error, and neither is the
 * "never throws, never fabricates" contract the rest of this module's
 * siblings hold themselves to. A label whose (start, end) pair does not
 * fully fit in `timestamps` is dropped rather than pushed with a missing
 * field.
 */
export function pairTimestampsWithLabels(labels: readonly string[], timestamps: BigInt64Array): PassTimingSample[] {
  const samples: PassTimingSample[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (i * 2 + 1 >= timestamps.length) break; // buffer shorter than this (and every later) label needs — stop rather than fabricate a partial pair.
    samples.push({ label: labels[i], startNs: timestamps[i * 2], endNs: timestamps[i * 2 + 1] });
  }
  return samples;
}

/**
 * Records GPU timestamp queries for the passes of one frame and resolves
 * them into `PassTimingSample[]` (nanosecond pairs; see `frame-timing.ts`
 * for what happens to them next). One instance is good for one frame's
 * worth of passes up to `maxPasses`, then must be recreated (or reset via
 * `beginFrame()`) for the next — this keeps the query-set/readback-buffer
 * lifetime unambiguous rather than trying to make it silently reusable
 * across frames while a previous frame's readback might still be pending.
 */
export class GpuFrameTimingRecorder {
  private readonly device: GPUDevice;
  private readonly maxPasses: number;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private labels: string[] = [];
  private nextQueryIndex = 0;
  private resolved = false;

  private constructor(device: GPUDevice, maxPasses: number, querySet: GPUQuerySet, resolveBuffer: GPUBuffer, readbackBuffer: GPUBuffer) {
    this.device = device;
    this.maxPasses = maxPasses;
    this.querySet = querySet;
    this.resolveBuffer = resolveBuffer;
    this.readbackBuffer = readbackBuffer;
  }

  /**
   * Returns a recorder, or `null` if the device's adapter did not advertise
   * `'timestamp-query'` — callers must treat `null` as "cannot measure this
   * way" and either fall back to CPU-side timing (`decideTimingMode` in
   * `frame-timing.ts`) or skip measurement, never throw.
   */
  static create(device: GPUDevice, maxPasses = 8): GpuFrameTimingRecorder | null {
    if (!hasTimestampQueryFeature(device.features)) return null;

    const querySet = device.createQuerySet({ type: 'timestamp', count: maxPasses * 2, label: 'frame-timing-queries' });
    const resolveBuffer = device.createBuffer({
      size: queryBufferSizeBytes(maxPasses),
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'frame-timing-resolve',
    });
    const readbackBuffer = device.createBuffer({
      size: queryBufferSizeBytes(maxPasses),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: 'frame-timing-readback',
    });
    return new GpuFrameTimingRecorder(device, maxPasses, querySet, resolveBuffer, readbackBuffer);
  }

  /**
   * Returns the `timestampWrites` object for the next pass, labelled
   * `label`. Pass it straight into `beginRenderPass`'s descriptor. Returns
   * `null` once `maxPasses` passes have been begun this frame — a caller
   * that hits this should raise `maxPasses` at construction, not retry.
   */
  beginPass(label: string): GPURenderPassTimestampWrites | null {
    const allocation = allocatePassQueryIndices(this.nextQueryIndex, this.maxPasses);
    if (allocation === null) return null;
    this.nextQueryIndex = allocation.nextQueryIndex;
    this.labels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: allocation.beginningOfPassWriteIndex,
      endOfPassWriteIndex: allocation.endOfPassWriteIndex,
    };
  }

  /** Resolves every query written this frame into the readback buffer. Call once, after every pass has been `.end()`-ed, before `queue.submit`. */
  endFrame(encoder: GPUCommandEncoder): void {
    if (this.nextQueryIndex === 0) return; // no passes recorded — nothing to resolve
    encoder.resolveQuerySet(this.querySet, 0, this.nextQueryIndex, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readbackBuffer, 0, this.nextQueryIndex * BYTES_PER_TIMESTAMP);
    this.resolved = true;
  }

  /**
   * Maps the readback buffer and returns this frame's `PassTimingSample[]`,
   * or `null` if `endFrame` was never called (nothing was recorded, or the
   * caller forgot). Async because `mapAsync` is: the caller's queue submit
   * must have completed first for the buffer to contain real data — WebGPU
   * enforces this by making `mapAsync` wait for pending GPU work that
   * touches the buffer.
   */
  async readback(): Promise<PassTimingSample[] | null> {
    if (!this.resolved) return null;
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const raw = this.readbackBuffer.getMappedRange(0, this.nextQueryIndex * BYTES_PER_TIMESTAMP);
    const timestamps = new BigInt64Array(raw.slice(0)); // copy out before unmap invalidates the ArrayBuffer
    this.readbackBuffer.unmap();

    return pairTimestampsWithLabels(this.labels, timestamps);
  }

  /** Resets for the next frame's recording. Does not reallocate the query set or buffers — they are sized once at `create()` and reused. */
  beginFrame(): void {
    this.labels = [];
    this.nextQueryIndex = 0;
    this.resolved = false;
  }

  /** Releases the GPU query set and buffers. Call when timing is turned off. */
  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
