/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorldPoint } from './relative-to-eye.js';

/** Which geometry path an occluder draw takes through the shadow pass. */
export type ShadowDrawKind = 'flat' | 'quantized' | 'instanced' | 'textured';

/** One occluder draw recorded into the depth pre-pass. */
export interface ShadowOccluderDraw {
  kind: ShadowDrawKind;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  /** Linear model; source translation is carried by `origin`. */
  model?: Float32Array;
  /** Canonical f64 drawable origin, or the legacy matrix translation. */
  origin?: WorldPoint;
  /** Dequantization parameters, for the quantized path only. */
  quantParams?: readonly [number, number, number, number];
  instanceBuffer?: GPUBuffer;
  instanceCount?: number;
}

/** Camera-owned RTE inputs for one shadow submission. */
export interface ShadowRteFrame { cameraWorld: WorldPoint }

/** World-space clip contract shared by colour and depth paths. */
export interface ShadowClip {
  section?: { normal: readonly [number, number, number]; distance: number; flipped?: boolean } | null;
  box?: { min: readonly [number, number, number]; max: readonly [number, number, number] } | null;
}

/** Choose the allocated shadow-map size within the device texture limit. */
export function resolveShadowMapResolution(requested: number | undefined, maxTextureDim: number): number {
  const cap = Number.isFinite(maxTextureDim) && maxTextureDim >= 1024 ? maxTextureDim : 2048;
  if (requested && requested > 0) return Math.max(256, Math.floor(Math.min(requested, cap)));
  if (cap >= 8192) return 4096;
  if (cap >= 4096) return 2048;
  return 1024;
}
