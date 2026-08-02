/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packing for the GPU picker's per-pass uniform block (32 floats / 128 bytes):
 *
 *   0-15  viewProj   mat4x4<f32>
 *   16-19 clipBoxMin vec4<f32>   (xyz min corner, w pad)
 *   20-23 clipBoxMax vec4<f32>   (xyz max corner, w pad)
 *   24-27 sectionPlane vec4<f32> (xyz normal, w distance)
 *   28-31 clipFlags  vec4<u32>   (x: bit0 sectionEnabled, bit1 flipped, bit2 clipBox)
 *
 * Kept as a pure helper so the layout (which must match `picker.ts`'s WGSL
 * `Uniforms` struct and the main render's section/clip discards) is unit-testable
 * without a GPU device. Mirrors how `packClipBox` is shared + tested.
 */
import { packClipBox } from './clip-box.js';
import type { PickClipState } from './types.js';

/**
 * Write the picker uniform block into `out` (>= 32 floats) and `outFlags` (a
 * Uint32 view of the same buffer at float lane 28 / byte 112). `clip` is the
 * section plane + crop box the last render applied; an absent section / box
 * leaves its flag bit clear so picks aren't clipped.
 */
export function packPickUniforms(
  viewProj: Float32Array,
  clip: PickClipState | null | undefined,
  out: Float32Array,
  outFlags: Uint32Array,
): void {
  out.set(viewProj.subarray(0, 16), 0);
  // clip box min/max at lanes 16-23; returns the clip-box enable bit (4) or 0.
  let flags = packClipBox(clip?.clipBox, out, 16);
  const sp = clip?.sectionPlane;
  if (sp) {
    out[24] = sp.normal[0];
    out[25] = sp.normal[1];
    out[26] = sp.normal[2];
    out[27] = sp.distance;
    flags |= 1; // sectionEnabled
    if (sp.flipped) flags |= 2; // flipped
  } else {
    out[24] = 0;
    out[25] = 0;
    out[26] = 0;
    out[27] = 0;
  }
  outFlags[0] = flags;
  outFlags[1] = 0;
  outFlags[2] = 0;
  outFlags[3] = 0;
}
