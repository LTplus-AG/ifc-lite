/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clip box (section / crop box) uniform packing. The box is an axis-aligned
 * world-space AABB written into the shared per-draw uniform as two vec4 lanes
 * (min.xyz + pad, max.xyz + pad); `main.wgsl` discards fragments outside it when
 * the enabled flag bit is set. Kept as a tiny pure helper so the three write
 * sites (pipeline.updateUniforms + the renderer's per-mesh and instanced
 * template loops) stay in sync and the packing is unit-testable.
 */
import type { ClipBox } from './types.js';

/** flags.y bit marking the clip box active. Must match `main.wgsl` (`& 4u`). */
export const CLIPBOX_ENABLED_BIT = 4;

/**
 * Write `box` into `out` at float lanes [`minFloatOffset` .. +3] (min.xyz + pad)
 * and [`minFloatOffset + 4` .. +3] (max.xyz + pad). Returns the flags.y bit to OR
 * in: {@link CLIPBOX_ENABLED_BIT} when the box is active, else 0. A disabled or
 * absent box zeroes the region so stale data from a previous draw can't clip.
 */
export function packClipBox(
  box: ClipBox | null | undefined,
  out: Float32Array,
  minFloatOffset: number,
): number {
  const maxOff = minFloatOffset + 4;
  if (box?.enabled) {
    out[minFloatOffset] = box.min[0];
    out[minFloatOffset + 1] = box.min[1];
    out[minFloatOffset + 2] = box.min[2];
    out[minFloatOffset + 3] = 0;
    out[maxOff] = box.max[0];
    out[maxOff + 1] = box.max[1];
    out[maxOff + 2] = box.max[2];
    out[maxOff + 3] = 0;
    return CLIPBOX_ENABLED_BIT;
  }
  out[minFloatOffset] = 0;
  out[minFloatOffset + 1] = 0;
  out[minFloatOffset + 2] = 0;
  out[minFloatOffset + 3] = 0;
  out[maxOff] = 0;
  out[maxOff + 1] = 0;
  out[maxOff + 2] = 0;
  out[maxOff + 3] = 0;
  return 0;
}
