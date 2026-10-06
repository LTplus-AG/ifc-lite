/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The frames scan-to-BIM detection crosses (#6894).
 *
 * The retained scan sample is Y-up and decode-relative. The renderer's point
 * cloud matrix `M` (column-major, alignment and manual placement included)
 * takes it to the render frame. The render frame plus the workspace anchor's
 * offset, swapped to Z-up, is the workspace world: IFC Z-up metres in the
 * anchor model's (georeferenced) coordinates, the frame scan landmarks use
 * (`lib/appearance/scan/landmarks.ts`). Proposals are made there.
 *
 * Creating an element goes back the same way (`workspaceToRender`) and then
 * through the target storey's workplane (`renderToLocal`), the one map every
 * Model workspace command uses: it carries the target model's RTC, rotation,
 * federation alignment and placement, so this module never restates them.
 *
 * `scanToModelMatrix` composes the forward chain into the row-major similarity
 * `proposeScanElements` takes; `sectionBoxToScanRegion` takes the section box
 * back into the sample frame for `segmentScan`'s `region`.
 */

import type { ScanRegion, ScanVec3 } from '@ifc-lite/geometry/scan-segmentation';
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';

/** Column-major 4x4, as the renderer reports point cloud transforms. */
export type ColumnMajor4 = ArrayLike<number>;

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Sample frame -> workspace world (Z up, metres), row-major. `pointCloudMatrix`
 * null means the sample is already in the render frame.
 */
export function scanToModelMatrix(state: ViewerState, pointCloudMatrix: ColumnMajor4 | null | undefined): number[] {
  const m = pointCloudMatrix ?? IDENTITY;
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  const linear = (row: number, col: number) => m[col * 4 + row];
  // Render-frame translation plus the workspace offset, Y-up.
  const t = [m[12] + offset.x, m[13] + offset.y, m[14] + offset.z];
  // Y-up (x, y, z) -> Z-up (x, -z, y): rows 0, -2, 1 of the render frame.
  const rows: Array<[number, number]> = [[0, 1], [2, -1], [1, 1]];
  const out: number[] = [];
  for (const [source, sign] of rows) {
    out.push(sign * linear(source, 0), sign * linear(source, 1), sign * linear(source, 2), sign * t[source]);
  }
  out.push(0, 0, 0, 1);
  return out.map((v) => v + 0);
}

/** Workspace world (Z up) -> render frame (Y up): the inverse of the chain above without `M`. */
export function workspaceToRender(state: ViewerState, p: ScanVec3): ScanVec3 {
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  return [p[0] - offset.x, p[2] - offset.y, -p[1] - offset.z];
}

function transformColumnMajor(m: ColumnMajor4, p: ScanVec3): ScanVec3 {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) as ScanVec3;
}

/** Inverse of an affine column-major 4x4 (general 3x3 inverse). Null when singular. */
export function invertAffine(m: ColumnMajor4): number[] | null {
  const a = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = [
    [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
    [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
    [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
  ];
  const t = [m[12], m[13], m[14]];
  const it = inv.map((row) => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]));
  return [
    inv[0][0], inv[1][0], inv[2][0], 0,
    inv[0][1], inv[1][1], inv[2][1], 0,
    inv[0][2], inv[1][2], inv[2][2], 0,
    it[0], it[1], it[2], 1,
  ];
}

/**
 * The render-frame section box as an axis-aligned region of the sample frame:
 * the bounds of its eight corners mapped back through `M`. Under a rotated
 * alignment the region is larger than the box (a superset, never a subset).
 */
export function sectionBoxToScanRegion(
  box: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  pointCloudMatrix: ColumnMajor4 | null | undefined,
): ScanRegion | null {
  const inverse = pointCloudMatrix ? invertAffine(pointCloudMatrix) : IDENTITY;
  if (!inverse) return null;
  const min: ScanVec3 = [Infinity, Infinity, Infinity];
  const max: ScanVec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const p = transformColumnMajor(inverse, [x, y, z]);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a]);
      max[a] = Math.max(max[a], p[a]);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

/** Sample point -> render frame, through `M`. */
export function sampleToRender(pointCloudMatrix: ColumnMajor4 | null | undefined, p: ScanVec3): ScanVec3 {
  return pointCloudMatrix ? transformColumnMajor(pointCloudMatrix, p) : p;
}
