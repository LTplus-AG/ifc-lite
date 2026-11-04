// SPDX-License-Identifier: MPL-2.0
import { totalYupOffset, type RenderFrameInfo } from '@ifc-lite/geometry/world-frame';
import { captureAxisMatrix, DEFAULT_CAPTURE_UP_AXIS, type CaptureUpAxis } from './pointCloudFrame.js';

export const IDENTITY_CAPTURE_PLACEMENT: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** T(-shared render offset) · caller placement · source axes. Column vectors.
 * Explicit matrices historically supply their own axis mapping; absent an
 * override they retain that mapping. PLY and .splat declare no standard up-axis.
 * Unplaced captures use the same Z-up default as point-cloud ingest.
 */
export function gaussianCaptureFrame(placement?: readonly number[], upAxis?: CaptureUpAxis, frame?: RenderFrameInfo | null) {
  const sourcePlacement = placement ?? IDENTITY_CAPTURE_PLACEMENT;
  if (sourcePlacement.length !== 16 || !sourcePlacement.every(Number.isFinite)) throw new Error('A capture placement needs 16 finite matrix values.');
  const axis = upAxis ?? (placement ? 'y' : DEFAULT_CAPTURE_UP_AXIS);
  const basis = captureAxisMatrix(axis);
  const matrix = Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, col = Math.floor(i / 4);
    return sourcePlacement[row] * basis[col * 4] + sourcePlacement[row + 4] * basis[col * 4 + 1]
      + sourcePlacement[row + 8] * basis[col * 4 + 2] + sourcePlacement[row + 12] * basis[col * 4 + 3];
  });
  const offset = totalYupOffset(frame);
  matrix[12] -= offset.x;
  matrix[13] -= offset.y;
  matrix[14] -= offset.z;
  return { placement: matrix, sourcePlacement: [...sourcePlacement], upAxis: axis, frameOffset: offset };
}
