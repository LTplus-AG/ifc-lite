/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A contiguous overlay batch exceeds its model's reserved safe ID space. */
export class OverlayIdSpaceExhaustedError extends Error {
  readonly reason = 'id-space-exhausted';
  constructor() {
    super('This model does not have enough safe entity IDs for edits in this session');
    this.name = 'OverlayIdSpaceExhaustedError';
  }
}
