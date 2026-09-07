/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface ByteStreamingPrePassResult {
  jobs: Uint32Array;
  totalJobs: number;
  unitScale: number;
  rtcOffset?: Float64Array;
  needsShift: boolean;
  buildingRotation?: number | null;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  /** Prepass-resolved plane-angle→radians scale (additive wire field). */
  planeAngleToRadians?: number;
  /** #407/#913 §2.3 per-element material colour lists (flat encoding). */
  materialElementIds?: Uint32Array;
  materialColorCounts?: Uint32Array;
  materialColors?: Uint8Array;
}
