/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN } from './instanced-render.js';
import type { InstancedOccurrence, InstancedTemplateCpu } from './scene-instance-types.js';

/**
 * Set HIDDEN on a deleted entity's records in the CPU instance data (#10639).
 * Its slots are not reclaimed, and device recovery and model placement
 * re-upload whole instance buffers from this data. Flag writes made with a
 * device already mirror into it (#10767); this also covers a delete made with
 * no device, where no flag write ran. Without it the occurrences would draw
 * again after the next re-upload.
 */
export function tombstoneInstanceRecords(
  cpu: readonly (InstancedTemplateCpu | undefined)[],
  occurrences: readonly InstancedOccurrence[],
): void {
  for (const { templateIndex, byteOffset } of occurrences) {
    const data = cpu[templateIndex]?.instanceData;
    if (!data) continue;
    const view = new DataView(data), at = byteOffset + INSTANCE_FLAGS_OFFSET;
    view.setUint32(at, (view.getUint32(at, true) | INSTANCE_FLAG_HIDDEN) >>> 0, true);
  }
}
