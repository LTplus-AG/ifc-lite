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
