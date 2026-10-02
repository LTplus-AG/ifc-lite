/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Effective same-grid/different-row validation for persisted IFC
 * intersections (#6232), including source axes under manually built anchors.
 * Generic IFC emission preserves valid curved and radial axes. */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';

export function assertGridIntersectionOwner(
  editor: StoreEditor,
  axes: readonly [number, number],
  placementId: number | undefined,
  op: string,
  sourceStore?: IfcDataStore,
): { gridId: number; placementId: number | null } {
  const reader = new AnchorEntityReader(sourceStore ?? null, editor.getMutationView());
  if (!sourceStore && axes.some((id) => editor.getNewEntity(id) === null)) {
    throw new Error(`${op}: file-backed axes require the source store read context`);
  }
  if (axes.some((id) => reader.entity(id)?.type.toUpperCase() !== 'IFCGRIDAXIS')) {
    throw new Error(`${op}: IntersectingAxes must identify two live readable IfcGridAxis entities`);
  }
  const owners = axes.map(() => [] as { gridId: number; row: number }[]);
  for (const gridId of reader.ids('IFCGRID')) {
    const grid = reader.entity(gridId);
    if (!grid) continue;
    for (const row of [7, 8, 9]) {
      const refs = grid.attributes[row];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const axisId = refId(ref);
        axes.forEach((id, index) => { if (id === axisId) owners[index].push({ gridId, row }); });
      }
    }
  }
  if (owners[0].length !== 1 || owners[1].length !== 1 || owners[0][0].gridId !== owners[1][0].gridId) {
    throw new Error(`${op}: IntersectingAxes must belong to the same unambiguous IfcGrid`);
  }
  if (owners[0][0].row === owners[1][0].row) {
    throw new Error(`${op}: IntersectingAxes must belong to different rows of their IfcGrid`);
  }
  const gridId = owners[0][0].gridId;
  const placement = reader.entity(gridId)?.attributes[5];
  const actualPlacement = refId(placement);
  if ((placement !== null && placement !== undefined && actualPlacement === null)
    || (placementId !== undefined && placementId !== actualPlacement)) {
    throw new Error(`${op}: GridPlacementId must identify the owning grid's ObjectPlacement`);
  }
  return { gridId, placementId: actualPlacement };
}
