/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Uniform layout + writer for the point-cloud render pipeline.
 *
 * Extracted from `point-cloud-renderer.ts` to keep the orchestration
 * class small. The layout matches `point-shader.wgsl.ts` byte-for-byte;
 * any shader edit needs to come back here too.
 */

import { POINT_UNIFORM_SIZE } from './point-pipeline.js';
import type { PointCloudNode } from './point-cloud-node.js';

export type PointColorMode =
  | 'rgb'
  | 'classification'
  | 'intensity'
  | 'height'
  | 'fixed';

export type PointSizeMode = 'fixed-px' | 'adaptive-world' | 'attenuated';

export const COLOR_MODE_INDEX: Record<PointColorMode, number> = {
  rgb: 0,
  classification: 1,
  intensity: 2,
  height: 3,
  fixed: 4,
};

export const SIZE_MODE_INDEX: Record<PointSizeMode, number> = {
  'fixed-px': 0,
  'adaptive-world': 1,
  'attenuated': 2,
};

export interface PointUniformInputs {
  viewProj: Float32Array;
  fixedColor: [number, number, number, number];
  colorMode: PointColorMode;
  sizeMode: PointSizeMode;
  pointSize: number;
  worldRadius: number;
  roundShape: boolean;
  sectionNormal: [number, number, number];
  sectionDist: number;
  sectionEnabled: boolean;
  heightMin: number;
  heightMax: number;
  viewportW: number;
  viewportH: number;
  /** Per-ASPRS-class visibility bitmask (32 bits = LAS 1.4 classes). */
  classMask: number;
}

/**
 * Pack the per-asset point-cloud uniform block into `scratch` and copy
 * it onto the GPU. The two scratch typed-arrays must alias the same
 * underlying buffer so we can write floats and packed u32 flags in one
 * pass.
 */
export function writePointCloudUniforms(
  device: GPUDevice,
  scratch: Float32Array,
  scratchU32: Uint32Array,
  node: PointCloudNode,
  inputs: PointUniformInputs,
): void {
  const u = scratch;
  const uU32 = scratchU32;

  // viewProj — floats 0..15
  u.set(inputs.viewProj.subarray(0, 16), 0);
  // model — floats 16..31 (identity for now; per-asset transforms can be added later)
  u.fill(0, 16, 32);
  u[16] = 1; u[21] = 1; u[26] = 1; u[31] = 1;
  // colorOverride — floats 32..35
  u[32] = inputs.fixedColor[0];
  u[33] = inputs.fixedColor[1];
  u[34] = inputs.fixedColor[2];
  u[35] = inputs.fixedColor[3];
  // colorModeAndExtras — floats 36..39 (mode, pointSize, heightMin, heightMax)
  u[36] = COLOR_MODE_INDEX[inputs.colorMode];
  u[37] = inputs.pointSize;
  u[38] = inputs.heightMin;
  u[39] = inputs.heightMax;
  // sizing — floats 40..43 (sizeMode, worldRadius, viewportW, viewportH)
  u[40] = SIZE_MODE_INDEX[inputs.sizeMode];
  u[41] = inputs.worldRadius;
  u[42] = inputs.viewportW;
  u[43] = inputs.viewportH;
  // sectionPlane — floats 44..47
  u[44] = inputs.sectionNormal[0];
  u[45] = inputs.sectionNormal[1];
  u[46] = inputs.sectionNormal[2];
  u[47] = inputs.sectionDist;
  // flags (u32 view) — bytes 192..207 = u32 indices 48..51
  // flags.x = the asset's CURRENT expressId. The shader uses this
  // when non-zero so the federation registry can relabel a streamed
  // asset post-upload (its per-vertex entityId attribute is baked
  // at upload and would otherwise stay at the synthetic local ID).
  // flags.w (u32 slot 51) = ASPRS class-visibility mask. Bit i set → class i shown.
  uU32[48] = node.meta.expressId >>> 0;
  uU32[49] = inputs.sectionEnabled ? 1 : 0;
  uU32[50] = inputs.roundShape ? 1 : 0;
  uU32[51] = inputs.classMask >>> 0;

  // Pass the typed array directly — TypeScript widens `.buffer` to
  // `ArrayBufferLike` here (vs. `ArrayBuffer` on a class field), which
  // doesn't satisfy `writeBuffer`'s parameter type. Slicing the typed
  // array view to exactly the uniform size + 4 alignment is identical
  // to the byteOffset/byteLength form on the buffer.
  device.queue.writeBuffer(node.uniformBuffer, 0, u, 0, POINT_UNIFORM_SIZE / 4);
}
