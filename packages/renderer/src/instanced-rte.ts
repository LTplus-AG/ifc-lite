/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Camera-relative instance-record uploads shared by colour, pick and shadow. */

import {
  INSTANCE_ANCHOR_HIGH_OFFSET,
  INSTANCE_STRIDE_BYTES,
} from './instanced-render.js';
import { packRteDrawableDelta, type WorldPoint } from './relative-to-eye.js';

export interface InstancedRteTemplate {
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  /** Canonical f64 Y-up drawable origins, xyz for each instance. */
  canonicalAnchors: Float64Array;
}

/**
 * Refresh per-instance `(drawable - camera)` lanes for one GPU submission.
 *
 * This is intentionally the sole writer of the V2 lanes after upload. It
 * applies the shared f64 boundary/envelope check before any f32 rounding, so
 * a colour, picker or shadow pass cannot independently subtract two large
 * rounded origins on the GPU.
 */
export function uploadInstancedRteDeltas(
  device: GPUDevice,
  templates: readonly InstancedRteTemplate[],
  camera: WorldPoint,
): void {
  const packed = new Float32Array(8);
  for (const template of templates) {
    if (template.canonicalAnchors.length !== template.instanceCount * 3) {
      throw new RangeError('Instanced RTE anchors do not match the instance-buffer record count.');
    }
    for (let instance = 0; instance < template.instanceCount; instance++) {
      const source = instance * 3;
      packRteDrawableDelta([
        template.canonicalAnchors[source]!,
        template.canonicalAnchors[source + 1]!,
        template.canonicalAnchors[source + 2]!,
      ], camera, packed, 0);
      device.queue.writeBuffer(
        template.instanceBuffer,
        instance * INSTANCE_STRIDE_BYTES + INSTANCE_ANCHOR_HIGH_OFFSET,
        packed,
      );
    }
  }
}
