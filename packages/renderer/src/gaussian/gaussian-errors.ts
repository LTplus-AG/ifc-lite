/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Stable failure classes of the internal Gaussian adapter; callers branch on `code`, never on text. */
export type GaussianSplatErrorCode =
  | 'not-ready'
  | 'invalid-attributes'
  | 'invalid-placement'
  | 'non-similarity-placement'
  | 'unsupported-reflection'
  | 'anchor-extent'
  | 'resource-limit'
  | 'upstream-capability-missing'
  /** The upstream renderer could not be loaded this time (e.g. a chunk fetch failed); retryable. */
  | 'upstream-unavailable'
  | 'stale-handle'
  | 'aborted'
  | 'lost'
  | 'disposed';

export class GaussianSplatError extends Error {
  constructor(readonly code: GaussianSplatErrorCode, message: string) {
    super(message);
    this.name = 'GaussianSplatError';
  }
}

/** Map the renderer lifetime to the error an operation must reject with, if any. */
export function assertUsableLifetime(life: { ready: boolean; lost: boolean; disposed: boolean }): void {
  if (life.disposed) throw new GaussianSplatError('disposed', 'The renderer was destroyed.');
  if (life.lost) throw new GaussianSplatError('lost', 'The GPU device is lost.');
  if (!life.ready) throw new GaussianSplatError('not-ready', 'The renderer is not initialized.');
}

export function requireDevice(device: GPUDevice | null): GPUDevice {
  if (!device) throw new GaussianSplatError('lost', 'No current GPU device.');
  return device;
}
