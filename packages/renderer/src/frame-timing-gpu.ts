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
      size: maxPasses * 2 * BYTES_PER_TIMESTAMP,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'frame-timing-resolve',
    });
    const readbackBuffer = device.createBuffer({
      size: maxPasses * 2 * BYTES_PER_TIMESTAMP,
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
    if (this.nextQueryIndex + 1 >= this.maxPasses * 2) return null;
    const beginningOfPassWriteIndex = this.nextQueryIndex;
    const endOfPassWriteIndex = this.nextQueryIndex + 1;
    this.nextQueryIndex += 2;
    this.labels.push(label);
    return { querySet: this.querySet, beginningOfPassWriteIndex, endOfPassWriteIndex };
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

    const samples: PassTimingSample[] = [];
    for (let i = 0; i < this.labels.length; i++) {
      samples.push({ label: this.labels[i], startNs: timestamps[i * 2], endNs: timestamps[i * 2 + 1] });
    }
    return samples;
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
