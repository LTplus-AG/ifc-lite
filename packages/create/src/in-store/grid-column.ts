/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A column bound to a real linear grid crossing (#6232). The canonical IFC
 * intersection emitter also accepts radial curves; this snapping consumer
 * intentionally requires readable, finite straight axes. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { addColumnToStore, type ColumnBuildResult, type ColumnInStoreParams, type ProfiledColumnInStoreParams } from './column.js';
import { readAxisEnds } from './extract-grids.js';
import { gridIntersectionPlacement, type GridPlacementResult } from './grid.js';
import { assertGridIntersectionOwner } from './grid-intersection-read.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { applyFrame, placementRelativeTo, refId } from './host-geometry-frame.js';

export interface GridColumnBinding {
  /** Model-local IfcGrid expressId. */
  GridId: number;
  /** The two actual IfcGridAxis references retained by the snap. */
  IntersectingAxes: readonly [number, number];
}

export interface GridColumnBuildResult extends ColumnBuildResult {
  gridPlacement: GridPlacementResult;
}

/** Persist a column's current storey-local position and section heading as a
 * local child of an IfcGridPlacement. Revalidates the live crossing before
 * writing; stale/unsupported snaps and failed column parameters leave no
 * helper entities. Heights and offsets are metres at this API boundary. */
export function addColumnOnGridToStore(
  editor: StoreEditor,
  sourceStore: IfcDataStore,
  anchor: SpatialAnchor,
  params: ColumnInStoreParams | ProfiledColumnInStoreParams,
  binding: GridColumnBinding,
): GridColumnBuildResult {
  const op = 'addColumnOnGridToStore';
  return editor.runAtomic((draft) => {
    const reader = new AnchorEntityReader(sourceStore, draft.getMutationView());
    const owner = assertGridIntersectionOwner(draft, binding.IntersectingAxes, undefined, op, sourceStore);
    if (owner.gridId !== binding.GridId || owner.placementId === null || anchor.storeyPlacementId === null) {
      throw new Error(`${op}: the crossing must identify the owning grid and a resolvable storey frame`);
    }
    const frame = placementRelativeTo(reader, owner.placementId, anchor.storeyPlacementId);
    if (!frame || Math.abs(frame.z[0]) > 1e-6 || Math.abs(frame.z[1]) > 1e-6 || frame.z[2] <= 0) {
      throw new Error(`${op}: the grid must have a readable horizontal placement in the storey frame`);
    }
    const curves = binding.IntersectingAxes.map((id) => {
      const curve = refId(reader.entity(id)?.attributes[1]);
      return curve === null ? null : readAxisEnds((entityId) => reader.entity(entityId), curve);
    });
    const [p, q] = curves;
    if (!p || !q) throw new Error(`${op}: linear snapping requires readable straight grid curves`);
    const r = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
    const s = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
    const determinant = r[0] * s[1] - r[1] * s[0];
    const lengthProduct = Math.hypot(...r) * Math.hypot(...s);
    if (!(lengthProduct > 0) || !Number.isFinite(lengthProduct) || !Number.isFinite(determinant)
      || Math.abs(determinant) <= 1e-12 * lengthProduct) {
      throw new Error(`${op}: linear snapping requires finite, non-zero, non-parallel grid axes`);
    }
    const delta = [q[0][0] - p[0][0], q[0][1] - p[0][1]];
    const t = (delta[0] * s[1] - delta[1] * s[0]) / determinant;
    const u = (delta[0] * r[1] - delta[1] * r[0]) / determinant;
    if (![t, u].every((v) => Number.isFinite(v) && v >= -1e-6 && v <= 1 + 1e-6)) {
      throw new Error(`${op}: the crossing must lie on both grid segments`);
    }
    const crossing = applyFrame(frame, [p[0][0] + t * r[0], p[0][1] + t * r[1], 0]);
    const scale = anchor.lengthUnitScale ?? 1;
    if (!(scale > 0) || !Number.isFinite(scale) || !crossing.every(Number.isFinite)
      || !params.Position.every(Number.isFinite)
      || Math.hypot(params.Position[0] - crossing[0] * scale, params.Position[1] - crossing[1] * scale) > 1e-6) {
      throw new Error(`${op}: the snapped position no longer matches the live grid crossing`);
    }
    const heading = params.RefDirection ?? [1, 0, 0];
    const localHeading: [number, number, number] = [
      frame.x[0] * heading[0] + frame.x[1] * heading[1],
      frame.y[0] * heading[0] + frame.y[1] * heading[1],
      heading[2],
    ];
    // Default grid orientation is its local +X on every schema, including
    // IFC2X3. Put section rotation and workplane height in a real local child.
    const gridPlacement = gridIntersectionPlacement(draft, anchor, {
      Axes: binding.IntersectingAxes, GridPlacementId: owner.placementId,
    }, sourceStore);
    const column = addColumnToStore(draft, { ...anchor, storeyPlacementId: gridPlacement.placementId }, {
      ...params,
      Position: [0, 0, params.Position[2] - crossing[2] * scale],
      RefDirection: localHeading,
    });
    return { ...column, gridPlacement };
  });
}
