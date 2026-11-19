/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN } from './instanced-render.js';
import type { InstancedOccurrence, InstancedTemplateGPU } from './scene-instance-types.js';

/**
 * Instance-buffer slots of deleted entities (#10639).
 *
 * Deleting an instanced entity does not reclaim its slots; it writes their
 * HIDDEN flag on the GPU and forgets the entity. The scene must still know
 * those slots exist: the opaque instanced pass may only use its discard-free
 * shader while no slot can be discarded, and a replacement device's instance
 * buffers are rebuilt from the decoded shard bytes, which never carried the
 * flag.
 */
export class InstancedTombstones {
  private readonly slots = new Map<number, number[]>();

  /** True while any live template holds a tombstoned slot. */
  get any(): boolean { return this.slots.size > 0; }

  add(occurrences: readonly InstancedOccurrence[]): void {
    for (const { templateIndex, byteOffset } of occurrences) {
      const offsets = this.slots.get(templateIndex);
      if (offsets) offsets.push(byteOffset);
      else this.slots.set(templateIndex, [byteOffset]);
    }
  }

  /** Templates whose GPU buffers were destroyed take their slots with them. */
  forgetTemplates(templateIndices: Iterable<number>): void {
    for (const index of templateIndices) this.slots.delete(index);
  }

  clear(): void { this.slots.clear(); }

  /** Re-hide every tombstoned slot after the instance buffers were rebuilt. */
  write(device: GPUDevice, templates: readonly (InstancedTemplateGPU | undefined)[]): void {
    const flag = new Uint32Array([INSTANCE_FLAG_HIDDEN]);
    for (const [templateIndex, offsets] of this.slots) {
      const buffer = templates[templateIndex]?.instanceBuffer;
      if (buffer) for (const offset of offsets) device.queue.writeBuffer(buffer, offset + INSTANCE_FLAGS_OFFSET, flag);
    }
  }
}
