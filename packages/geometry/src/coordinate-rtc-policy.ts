/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from './types.js';

/** Legacy fallback for the native producer that has no authoritative frame. */
export function inferWasmRtcApplied(batch: MeshData[], threshold: number): boolean {
  let small = 0;
  let large = 0;
  for (const { positions } of batch) {
    if (positions.length < 3) continue;
    const max = Math.max(
      Math.abs(positions[0]),
      Math.abs(positions[1]),
      Math.abs(positions[2]),
    );
    if (max < threshold) small++;
    else large++;
  }
  return small + large > 0 && small / (small + large) > 0.5;
}
