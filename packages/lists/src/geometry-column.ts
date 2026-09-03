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
 *  Coordinate. `axis` is matched case-insensitively; absent or blank means X.
 *
 *  AN AXIS THAT IS NOT X/Y/Z RESOLVES TO NULL, NOT TO X (#3734). It used to
 *  share the `default` arm with `case 'X'`, so a column whose axis was `Q` --
 *  a hand-edited saved list, a definition from a schema that grew an axis this
 *  build does not know -- reported the X coordinate under a header saying
 *  something else. An empty cell is a visible gap; a plausible number under
 *  the wrong label is a wrong answer that reads as a right one, and nothing
 *  downstream can tell them apart. Blank still means X, which is the
 *  documented default for a column created without an axis. */
export function getWorldCoordinateValue(
  entityId: number,
  axis: string,
  provider: ListDataProvider,
): CellValue {
  const pos = provider.getWorldPosition?.(entityId);
  if (!pos) return null;
  switch (axis.trim().toUpperCase()) {
    case 'Y': return pos.y;
    case 'Z': return pos.z;
    case 'X':
    case '': return pos.x;
    default: return null;
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
