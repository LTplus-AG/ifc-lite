/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { COMPACT_CELL_METRES, loadCompactGeometry } from '@ifc-lite/geometry/compact';
import { loadCompactPages } from '@ifc-lite/renderer';

/**
 * Compact GPU records (`@ifc-lite/geometry` compact-geometry.ts): the geometry
 * workers encode eligible flat meshes as the renderer's final quantized
 * vertices, and the renderer uploads them without reading a vertex
 * (`@ifc-lite/renderer` compact-store.ts).
 *
 * Fetch the record decoder and the renderer's page code, both chunks of their
 * own, before a load's workers are configured. Imported only by a load that
 * asks for compact records (`compactCellSizeForLoad`).
 *
 * @returns the cell size to hand `GeometryProcessor.compactCellSize`.
 */
export async function enableCompactGeometry(): Promise<number> {
  await Promise.all([loadCompactGeometry(), loadCompactPages()]);
  return COMPACT_CELL_METRES;
}
