/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Lifecycle handling for asynchronous GPU picker readbacks. */

/** Picker/device teardown may abort pending maps; real map faults propagate. */
export function isReadbackAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Free aborted readbacks while preserving a visible diagnostic on a live device. */
export function releaseReadbacks(...buffers: GPUBuffer[]): void {
  for (const buffer of buffers) {
    try {
      buffer.destroy();
    } catch (err) {
      console.warn('[Picker] failed to release a readback buffer during teardown', err);
    }
  }
}

/** Pending readbacks belong to one picker; teardown and late finally share release. */
export class PickerReadbackOwner {
  private readonly pending = new Set<GPUBuffer>();

  track(...buffers: readonly GPUBuffer[]): void {
    for (const buffer of buffers) this.pending.add(buffer);
  }

  release(...buffers: readonly GPUBuffer[]): void {
    for (const buffer of buffers) {
      if (this.pending.delete(buffer)) releaseReadbacks(buffer);
    }
  }

  destroy(): void {
    this.release(...this.pending);
  }
}
