/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View-space reconstruction from the scene depth buffer, for screen-space
 * passes that have no normal or position target (ambient occlusion, #5384).
 *
 * The depth attachment holds reverse-Z device depth (1 at the near plane,
 * cleared to 0), produced by `MathUtils.perspectiveReverseZ` (infinite far
 * plane) or `MathUtils.orthographicReverseZ`. Both are handled by one
 * formula over four projection-matrix entries rather than a mode switch, so
 * a pass never has to know which camera mode drew the frame:
 *
 *   device depth d = (m10 * z + m14) / (m11 * z + m15)   (z = view-space z, < 0)
 *   =>        z = (m14 - d * m15) / (d * m11 - m10)
 *
 * and the view-space x/y follow from NDC and the clip w (`m11 * z + m15`):
 *
 *   x = (ndcX * w - m12) / m0,  y = (ndcY * w - m13) / m5
 *
 * (`m8`/`m9` are zero in both projections.) `shaders/depth-reconstruct.wgsl.ts`
 * is the WGSL twin of these functions; the unit tests round-trip real
 * projection matrices through the TS side.
 */

import type { Mat4 } from './types.js';

/** The projection entries the reconstruction needs, packed as two vec4s. */
export interface DepthReconstructParams {
  /** `[m10, m11, m14, m15]`: device depth to view-space z. */
  depth: [number, number, number, number];
  /** `[m0, m5, m12, m13]`: NDC x/y (with clip w) to view-space x/y. */
  xy: [number, number, number, number];
}

/** Extract the reconstruction params from a (column-major) projection matrix. */
export function depthReconstructParams(projection: Mat4): DepthReconstructParams {
  const m = projection.m;
  return {
    depth: [m[10], m[11], m[14], m[15]],
    xy: [m[0], m[5], m[12], m[13]],
  };
}

/** View-space z (negative in front of the camera) of a device depth value. */
export function viewZFromDepth(depth: number, p: DepthReconstructParams): number {
  const [m10, m11, m14, m15] = p.depth;
  return (m14 - depth * m15) / (depth * m11 - m10);
}

/** Clip-space w at view-space z: the view distance in perspective, 1 in ortho. */
export function clipWFromViewZ(viewZ: number, p: DepthReconstructParams): number {
  return p.depth[1] * viewZ + p.depth[3];
}

/** View-space position of an NDC point at a device depth. */
export function viewPositionFromDepth(
  ndcX: number,
  ndcY: number,
  depth: number,
  p: DepthReconstructParams,
): [number, number, number] {
  const z = viewZFromDepth(depth, p);
  const w = clipWFromViewZ(z, p);
  const [m0, m5, m12, m13] = p.xy;
  return [(ndcX * w - m12) / m0, (ndcY * w - m13) / m5, z];
}

/**
 * Pixels per world unit at clip w = 1, for a drawing buffer `heightPx` tall.
 * A world-space length `r` at clip w spans `r * scale / w` pixels.
 */
export function pixelsPerWorldUnit(projection: Mat4, heightPx: number): number {
  return 0.5 * heightPx * projection.m[5];
}
