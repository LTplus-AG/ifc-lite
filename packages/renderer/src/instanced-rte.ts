/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Camera-relative instance-record uploads shared by colour, pick and shadow. */

import {
  INSTANCE_ANCHOR_HIGH_OFFSET,
  INSTANCE_STRIDE_BYTES,
} from './instanced-render.js';
import { tryPackRteDrawableDelta, type WorldPoint } from './relative-to-eye.js';

export interface InstancedRteTemplate {
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  /** Canonical f64 Y-up drawable origins, xyz for each instance. */
  canonicalAnchors: Float64Array;
}

/** A contiguous `[first, first + count)` instance range, drawn via `firstInstance`. */
export interface InstanceRun {
  readonly first: number;
  readonly count: number;
}

/**
 * Refresh per-instance `(drawable - camera)` lanes for one GPU submission.
 *
 * This is intentionally the sole writer of the V2 lanes after upload. It
 * applies the shared f64 boundary/envelope check before any f32 rounding, so
 * a colour, picker or shadow pass cannot independently subtract two large
 * rounded origins on the GPU.
 *
 * An instance outside the camera-relative envelope cannot be rasterised in
 * this frame, and its record keeps a stale delta, so it must not be drawn.
 * The returned runs (one list per template, in order) cover exactly the
 * refreshed instances; draw them with `drawInstanceRuns` (#6128).
 */
export function uploadInstancedRteDeltas(
  device: GPUDevice,
  templates: readonly InstancedRteTemplate[],
  camera: WorldPoint,
): InstanceRun[][] {
  const packed = new Float32Array(8);
  return templates.map((template) => {
    if (template.canonicalAnchors.length !== template.instanceCount * 3) {
      throw new RangeError('Instanced RTE anchors do not match the instance-buffer record count.');
    }
    return collectInstanceRuns(template.instanceCount, (instance) => {
      const source = instance * 3;
      if (!tryPackRteDrawableDelta([
        template.canonicalAnchors[source]!,
        template.canonicalAnchors[source + 1]!,
        template.canonicalAnchors[source + 2]!,
      ], camera, packed, 0)) return false;
      device.queue.writeBuffer(
        template.instanceBuffer,
        instance * INSTANCE_STRIDE_BYTES + INSTANCE_ANCHOR_HIGH_OFFSET,
        packed,
      );
      return true;
    });
  });
}

/**
 * Visit instances `0..count-1` in order and group those for which `drawable`
 * returns true into maximal contiguous runs. `drawable` is called exactly once
 * per instance, so it may also perform that instance's upload.
 */
export function collectInstanceRuns(count: number, drawable: (instance: number) => boolean): InstanceRun[] {
  const runs: InstanceRun[] = [];
  let runStart = -1;
  for (let instance = 0; instance < count; instance++) {
    if (drawable(instance)) {
      if (runStart < 0) runStart = instance;
    } else if (runStart >= 0) {
      runs.push({ first: runStart, count: instance - runStart });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ first: runStart, count: count - runStart });
  return runs;
}

/** Draw the refreshed instance runs of the bound buffers; returns the draw-call count. */
export function drawInstanceRuns(
  pass: GPURenderPassEncoder,
  indexCount: number,
  runs: readonly InstanceRun[],
): number {
  for (const run of runs) pass.drawIndexed(indexCount, run.count, 0, 0, run.first);
  return runs.length;
}
