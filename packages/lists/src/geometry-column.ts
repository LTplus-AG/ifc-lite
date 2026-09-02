/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `geometry` column/condition source (issue #3671): the element's World
 * Coordinate (project-space placement, IFC Z-up, project length unit) — see
 * `ListDataProvider.getWorldPosition` in `types.ts` for the exact contract.
 * Split out of `engine.ts` to keep that file under its module-size budget.
 */

import { QuantityType } from '@ifc-lite/data';
import type { CellValue, ListDataProvider } from './types.js';

/** The `quantityType` tag a resolved geometry value carries, so the shared
 *  per-column unit resolver treats a World X/Y/Z cell exactly like a Length
 *  quantity column, no dedicated unit-kind code needed downstream. */
const WORLD_COORDINATE_QUANTITY_TYPE = QuantityType.Length;

/** Resolve a `geometry` column/condition to one axis of the element's World
 *  Coordinate. `axis` is matched case-insensitively (`X` default). */
export function getWorldCoordinateValue(
  entityId: number,
  axis: string,
  provider: ListDataProvider,
): CellValue {
  const pos = provider.getWorldPosition?.(entityId);
  if (!pos) return null;
  switch (axis.toUpperCase()) {
    case 'Y': return pos.y;
    case 'Z': return pos.z;
    case 'X':
    default: return pos.x;
  }
}

/** `extractColumnValues`'s `geometry` case: resolves the cell AND tags
 *  `meta.quantityType` (once, from the first non-null value) in one call. */
export function extractGeometryColumnValue(
  entityId: number,
  axis: string,
  provider: ListDataProvider,
  meta: { quantityType?: number },
): CellValue {
  const val = getWorldCoordinateValue(entityId, axis, provider);
  if (val !== null && meta.quantityType === undefined) meta.quantityType = WORLD_COORDINATE_QUANTITY_TYPE;
  return val;
}
