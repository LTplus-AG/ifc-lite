/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Lifecycle handling for asynchronous GPU picker readbacks. */

/** Only device teardown is an expected `AbortError`; real map faults propagate. */
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
