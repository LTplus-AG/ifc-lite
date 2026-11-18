/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live viewport frames that reached the GPU queue. A leaf module (no imports):
 * viewport-capture's `noteLiveFrameSubmitted` counts, settled-frame.ts reads.
 */
let submittedFrames = 0;

export function noteLiveFrame(): void {
  submittedFrames++;
}

export function liveFrameCount(): number {
  return submittedFrames;
}
