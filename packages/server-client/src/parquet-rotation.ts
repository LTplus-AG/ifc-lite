// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-instance rotation, shared by both Parquet transports (issues #3575, #3888).
 *
 * Split out of `parquet-tables.ts` to stay under that file's module-size
 * budget (see `parquet-columns.ts` for the same reasoning applied to the
 * shared trailing columns).
 *
 * The server dedupes rotated `IfcMappedItem` / shared-`IfcRepresentationMap`
 * occurrences by storing ONE template mesh in a canonical/local frame and
 * carrying each instance's rotation (row-major 3x3, `rot0..rot8`) alongside
 * its `origin_x/y/z`. The optimized transport has done this since #3575 and the
 * flat one since `-parquet-v6` (#3888); the columns, the frame and the
 * reconstruction are identical, which is why this module is shared rather than
 * copied. Reconstruction contract:
 * `world = origin + R * template_position` — the SAME `origin`-only contract
 * as before (#1841) when `R` is the identity, which is what the server emits
 * for every instance it did not verify a rotation-aware placement for.
 */

import type { ArrowTableLike } from './parquet-tables.js';
import { numericColumn } from './parquet-columns.js';

/** The nine `rot0..rot8` columns, present together or not at all. */
export type RotationColumns = ArrayLike<number>[];

/** Row-major identity, hoisted so the per-mesh identity check allocates nothing. */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Read the rotation columns, or `undefined` when the payload does not carry
 * them — an optimized wire-version-2 payload (#3575), or a flat `-parquet-v5`
 * blob (#3888). Callers then fall back to the identity rotation, which is
 * exactly the behaviour those payloads were written for.
 *
 * `onAbsent` says what a MISSING or short block means to the caller, in the
 * caller's own terms rather than in one transport's version numbering.
 * `'identity'` is the reading above. `'throw'` is for a payload whose own
 * header states the columns are there: the optimized format's version 3 is
 * only emitted once a non-identity rotation has actually been written
 * (`optimized_wire_version` in `parquet_instancing.rs`), so absence there is
 * truncated wire data, and decoding it as identity would place a genuinely
 * rotated occurrence at the wrong orientation with no signal why.
 *
 * The flat transport has no such header — it cannot tell a truncated v6 mesh
 * table from a genuine v5 one — so it passes `'identity'`, which is right for
 * the v5 case and no worse than throwing for the other.
 */
export function readRotationColumns(
  instanceArrow: ArrowTableLike,
  rowCount: number,
  onAbsent: 'identity' | 'throw' = 'identity'
): RotationColumns | undefined {
  const cols: ArrayLike<number>[] = [];
  for (let i = 0; i < 9; i++) {
    const col = numericColumn(instanceArrow, `rot${i}`);
    if (!col || col.length < rowCount) {
      if (onAbsent === 'throw') {
        throw new Error(
          'Malformed optimized Parquet geometry: format version 3 requires rot0..rot8 instance columns'
        );
      }
      return undefined;
    }
    cols.push(col);
  }
  return cols;
}

/** `true` when row `index`'s rotation is exactly identity (the common case). */
function isIdentityRow(rot: RotationColumns, index: number): boolean {
  for (let i = 0; i < 9; i++) {
    if (rot[i][index] !== IDENTITY[i]) return false;
  }
  return true;
}

/**
 * Rotate `positions` (and, when present, `normals`) IN PLACE by row `index`'s
 * 3x3 rotation. A no-op when the row is identity (translation-only or
 * unverified placements — the overwhelming majority of rows on most models),
 * so this costs nothing beyond the identity check for meshes #3575 did not
 * touch.
 *
 * Normals get the SAME rotation matrix as positions, not its inverse
 * transpose — correct for a rigid (orthogonal) rotation, which is what the
 * server's per-vertex residual check (`RECOMPOSITION_TOLERANCE_M`) verifies
 * before emitting a non-identity row. A non-uniform scale baked into the
 * source `IfcCartesianTransformationOperator` would need the inverse
 * transpose for normals specifically; this matches the convention the
 * existing GPU-instancing wire format (`ifc_lite_geometry::instancing`)
 * already uses, so it is not a new approximation this fix introduces.
 *
 * `isIdentityRow` already refuses to call a row with a NaN cell "identity"
 * (`NaN !== 1` is true, so the row fails the comparison and falls through
 * here) — a NaN can never silently render as an unrotated placement. But
 * multiplying it through `rotateTriplets` would still corrupt every vertex
 * of THIS instance to NaN, uncontrolled: no error, a mesh that may vanish
 * or wreck a shared bounding-box computation with no signal why. A row that
 * isn't finite is malformed wire data — the same class of fault
 * `buildMeshesFromOptimizedTables` already fails loudly on for a bad
 * mesh/material index — so it throws here too, instead of writing NaN
 * silently into the buffer.
 */
export function applyInstanceRotation(
  positions: Float32Array,
  normals: Float32Array | undefined,
  rot: RotationColumns,
  index: number
): void {
  if (isIdentityRow(rot, index)) return;
  const r = rot.map((col) => col[index]);
  if (!r.every(Number.isFinite)) {
    throw new Error(
      `Malformed optimized Parquet geometry: non-finite rotation value for instance ${index} (rot=[${r.join(', ')}])`
    );
  }
  rotateTriplets(positions, r);
  if (normals) rotateTriplets(normals, r);
}

function rotateTriplets(buf: Float32Array, r: number[]): void {
  for (let v = 0; v < buf.length; v += 3) {
    const x = buf[v];
    const y = buf[v + 1];
    const z = buf[v + 2];
    buf[v] = r[0] * x + r[1] * y + r[2] * z;
    buf[v + 1] = r[3] * x + r[4] * y + r[5] * z;
    buf[v + 2] = r[6] * x + r[7] * y + r[8] * z;
  }
}
