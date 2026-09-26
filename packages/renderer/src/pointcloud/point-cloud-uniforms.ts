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
import { isUsableModelMatrix } from './point-cloud-node.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';
import type { ClipBox } from '../types.js';
import { packRteClipBox, rtePlaneDistance } from '../rte-clip-space.js';

export type PointColorMode =
  | 'rgb'
  | 'classification'
  | 'intensity'
  | 'height'
  | 'fixed'
  | 'deviation';

export type PointSizeMode = 'fixed-px' | 'adaptive-world' | 'attenuated';

/** Number of u32 words in the 256-bit LAS class-visibility mask. */
export const CLASS_MASK_WORDS = 8;

/**
 * Normalize the public `classMask` option into the 8-word (256-bit)
 * uniform layout. Accepts:
 *   - `undefined`          → all classes visible
 *   - `number` (legacy)    → bits 0..31 as given; classes 32..255 stay
 *                            visible, matching the old 32-bit semantics
 *   - `ArrayLike<number>`  → up to 8 words, LSB-first; missing or
 *                            non-finite words default to all-visible
 */
export function normalizeClassMask(
  mask: number | ArrayLike<number> | undefined,
): Uint32Array {
  const out = new Uint32Array(CLASS_MASK_WORDS).fill(0xFFFFFFFF);
  if (mask === undefined) return out;
  if (typeof mask === 'number') {
    out[0] = Number.isFinite(mask) ? mask >>> 0 : 0xFFFFFFFF;
    return out;
  }
  for (let i = 0; i < CLASS_MASK_WORDS && i < mask.length; i++) {
    const word = mask[i];
    if (Number.isFinite(word)) out[i] = word >>> 0;
  }
  return out;
}

export const COLOR_MODE_INDEX: Record<PointColorMode, number> = {
  rgb: 0,
  classification: 1,
  intensity: 2,
  height: 3,
  fixed: 4,
  deviation: 5,
};

export const SIZE_MODE_INDEX: Record<PointSizeMode, number> = {
  'fixed-px': 0,
  'adaptive-world': 1,
  'attenuated': 2,
};

export interface PointUniformInputs {
  viewProj: Float32Array;
  relativeToEyeFrame: RelativeToEyeFrame;
  fixedColor: [number, number, number, number];
  colorMode: PointColorMode;
  sizeMode: PointSizeMode;
  pointSize: number;
  worldRadius: number;
  roundShape: boolean;
  sectionNormal: [number, number, number];
  sectionDist: number;
  sectionEnabled: boolean;
  /** Crop box shared with the mesh pass; narrowed only after f64 eye subtraction. */
  clipBox?: ClipBox | null;
  heightMin: number;
  heightMax: number;
  viewportW: number;
  viewportH: number;
  /** 256-bit LAS class-visibility mask, 8 u32 words LSB-first (#1783). */
  classMask: Uint32Array;
  /** Preview stride — 1 = full density, N = render every Nth point. */
  previewStride: number;
  /** BIM ↔ scan deviation heatmap range (metres). */
  deviationCenterOffset: number;
  deviationHalfRange: number;
}

/**
 * Pack the per-asset point-cloud uniform block into `scratch` and copy
 * it onto the GPU. The two scratch typed-arrays must alias the same
 * underlying buffer so we can write floats and packed u32 flags in one
 * pass.
 *
 * Returns false without uploading when the node's origin lies outside this
 * camera's RTE envelope: it cannot be rasterised this frame, so the caller
 * skips its draw rather than reusing the previous frame's uniforms (#6128).
 */
export function writePointCloudUniforms(
  device: GPUDevice,
  scratch: Float32Array,
  scratchU32: Uint32Array,
  node: PointCloudNode,
  inputs: PointUniformInputs,
): boolean {
  const u = scratch;
  const uU32 = scratchU32;

  // Translation-free RTE viewProj — floats 0..15.
  u.set(inputs.viewProj.subarray(0, 16), 0);
  // Model linear transform — floats 16..31. Its translation is separately
  // split against the camera below; do not narrow it into this f32 matrix.
  let origin: [number, number, number] = [0, 0, 0];
  if (isUsableModelMatrix(node.model)) {
    u.set(node.model, 16);
    origin = node.rteOrigin ?? [node.model[12], node.model[13], node.model[14]];
  } else {
    u.fill(0, 16, 32);
    u[16] = 1; u[21] = 1; u[26] = 1; u[31] = 1;
  }
  u[28] = 0; u[29] = 0; u[30] = 0; u[31] = 1;
  if (!inputs.relativeToEyeFrame.tryPackDrawableOrigin(origin, u, 32)) return false;
  const camera = inputs.relativeToEyeFrame.getCameraWorld();
  // colorOverride — floats 40..43
  u[40] = inputs.fixedColor[0];
  u[41] = inputs.fixedColor[1];
  u[42] = inputs.fixedColor[2];
  u[43] = inputs.fixedColor[3];
  // colorModeAndExtras — floats 44..47 (mode, pointSize, heightMin, heightMax)
  u[44] = COLOR_MODE_INDEX[inputs.colorMode];
  u[45] = inputs.pointSize;
  u[46] = inputs.heightMin - camera[1];
  u[47] = inputs.heightMax - camera[1];
  // sizing — floats 48..51 (sizeMode, worldRadius, viewportW, viewportH)
  u[48] = SIZE_MODE_INDEX[inputs.sizeMode];
  u[49] = inputs.worldRadius;
  u[50] = inputs.viewportW;
  u[51] = inputs.viewportH;
  // sectionPlane — floats 52..55. The shader now receives eye-relative
  // positions, so express the plane in that same frame.
  u[52] = inputs.sectionNormal[0];
  u[53] = inputs.sectionNormal[1];
  u[54] = inputs.sectionNormal[2];
  u[55] = rtePlaneDistance(inputs.sectionDist, inputs.sectionNormal, camera);
  // flags (u32 view) — bytes 224..239 = u32 indices 56..59
  // flags.x = the asset's CURRENT expressId. The shader uses this
  // when non-zero so the federation registry can relabel a streamed
  // asset post-upload (its per-vertex entityId attribute is baked
  // at upload and would otherwise stay at the synthetic local ID).
  // flags.w (u32 slot 59) = crop enabled; class visibility lives in its
  // own 256-bit block below.
  uU32[56] = node.meta.expressId >>> 0;
  uU32[57] = inputs.sectionEnabled ? 1 : 0;
  uU32[58] = inputs.roundShape ? 1 : 0;
  uU32[59] = inputs.clipBox?.enabled ? 1 : 0;
  // extras (u32 slots 60..63) — extras.x = previewStride, yzw reserved.
  uU32[60] = inputs.previewStride >>> 0;
  uU32[61] = 0;
  uU32[62] = 0;
  uU32[63] = 0;
  // deviationRange (f32 slots 64..67) — center, halfRange, _, _.
  u[64] = inputs.deviationCenterOffset;
  u[65] = inputs.deviationHalfRange;
  u[66] = 0;
  u[67] = 0;
  // classMask (u32 slots 68..75) — 256-bit LAS class-visibility mask,
  // bit (i % 32) of word (i / 32) set → class i shown.
  for (let w = 0; w < CLASS_MASK_WORDS; w++) {
    uU32[68 + w] = inputs.classMask[w] ?? 0xFFFFFFFF;
  }
  // Crop bounds follow classMask at floats 76..83. Point worldPos is already
  // eye-relative, so subtract before f32 narrowing just as the mesh ABI does.
  packRteClipBox(inputs.clipBox, camera, u, 76);

  // Pass the typed array directly — TypeScript widens `.buffer` to
  // `ArrayBufferLike` here (vs. `ArrayBuffer` on a class field), which
  // doesn't satisfy `writeBuffer`'s parameter type. Slicing the typed
  // array view to exactly the uniform size + 4 alignment is identical
  // to the byteOffset/byteLength form on the buffer.
  device.queue.writeBuffer(node.uniformBuffer, 0, u, 0, POINT_UNIFORM_SIZE / 4);
  return true;
}
