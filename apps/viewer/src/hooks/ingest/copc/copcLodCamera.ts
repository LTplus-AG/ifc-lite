/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's camera, re-expressed in a COPC asset's decoded frame
 * (#6869): Z-up, native coordinates minus the decode origin, which is the
 * frame `createCopcLodTree` reports node bounds in.
 *
 * The asset draws decoded points through `model · S`, where S is the
 * Z-up→Y-up swap `swapZupChunkToYup` applies and `model` is the asset's
 * placement (alignment, manual translation). Moving the camera into the
 * decoded frame (`viewProj · model · S`, eye through the inverse) keeps
 * every node box exact instead of re-boxing it per frame.
 */

import type { LodCamera } from '@ifc-lite/pointcloud';

/** Decoded (x, y, z) → renderer local (x, z, -y), column-major. */
export const ZUP_TO_YUP: readonly number[] = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

/** Column-major 4x4 product `a · b`, in f64. */
export function multiply4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Determinant of the linear (3x3) part of a column-major affine matrix. */
function linearDeterminant(m: ArrayLike<number>): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/** Apply the inverse of an affine column-major matrix to a point; null when singular. */
function inverseAffinePoint(m: ArrayLike<number>, p: readonly [number, number, number]): [number, number, number] | null {
  const det = linearDeterminant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const x = p[0] - m[12];
  const y = p[1] - m[13];
  const z = p[2] - m[14];
  // Rows of the inverse linear part (adjugate / det).
  const i00 = (m[5] * m[10] - m[9] * m[6]) / det;
  const i01 = (m[8] * m[6] - m[4] * m[10]) / det;
  const i02 = (m[4] * m[9] - m[8] * m[5]) / det;
  const i10 = (m[9] * m[2] - m[1] * m[10]) / det;
  const i11 = (m[0] * m[10] - m[8] * m[2]) / det;
  const i12 = (m[8] * m[1] - m[0] * m[9]) / det;
  const i20 = (m[1] * m[6] - m[5] * m[2]) / det;
  const i21 = (m[4] * m[2] - m[0] * m[6]) / det;
  const i22 = (m[0] * m[5] - m[4] * m[1]) / det;
  return [i00 * x + i01 * y + i02 * z, i10 * x + i11 * y + i12 * z, i20 * x + i21 * y + i22 * z];
}

export interface RendererCameraState {
  /** World view-projection (column-major). */
  viewProj: ArrayLike<number>;
  /** Projection matrix; element [1][1] (index 5) is the vertical scale. */
  proj: ArrayLike<number>;
  eye: readonly [number, number, number];
  viewportHeight: number;
  orthographic: boolean;
  /** Asset placement (column-major), or undefined for identity. */
  model?: ArrayLike<number>;
}

export function lodCameraInDecodedFrame(state: RendererCameraState): LodCamera | null {
  const toWorld = state.model ? multiply4(state.model, ZUP_TO_YUP) : [...ZUP_TO_YUP];
  const position = inverseAffinePoint(toWorld, state.eye);
  if (!position) return null;
  // Orthographic span is radius · scale; a placement scale s (e.g. a foot
  // CRS) shrinks decoded radii by s, so fold s into the projection scale.
  // Perspective spans are a radius/distance ratio and need no correction.
  const scale = Math.cbrt(Math.abs(linearDeterminant(toWorld)));
  return {
    viewProj: multiply4(state.viewProj, toWorld),
    position,
    viewportHeight: state.viewportHeight,
    projScaleY: Math.abs(state.proj[5]) * (state.orthographic ? scale : 1),
    orthographic: state.orthographic,
  };
}

/**
 * A top-down orthographic view of the whole octree cube in the decoded
 * frame, sized so the selection settles around level 2. Used before the
 * scene camera has framed the cloud: it loads the coarse, cloud-wide nodes
 * that seed bounds (so fit-to-view can find the scan) and the scan cache.
 */
export function overviewCamera(
  cube: { center: readonly [number, number, number]; halfsize: number },
  originOffset: readonly [number, number, number] | undefined,
): LodCamera {
  const [ox, oy, oz] = originOffset ?? [0, 0, 0];
  const cx = cube.center[0] - ox;
  const cy = cube.center[1] - oy;
  const top = cube.center[2] - oz + cube.halfsize * 2;
  const depth = cube.halfsize * 4;
  const s = 1 / cube.halfsize;
  // x' = s (x - cx), y' = s (y - cy), z' = (top - z) / depth in [0, 1].
  const viewProj = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, -1 / depth, 0, -s * cx, -s * cy, top / depth, 1];
  // Root span = sqrt(3) * halfsize * s * 300 px ~ 520 px: refines to level 2.
  return { viewProj, position: [cx, cy, top], viewportHeight: 300, projScaleY: s, orthographic: true };
}
