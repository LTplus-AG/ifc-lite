/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `Axis` representation of a rectangle wall (#6232 B2): `addWallToStore`
 * writes one beside the Body, a `Curve2D` IfcPolyline from the wall's Start to
 * its End in the wall's own frame. A resize that moves the wall by its
 * placement and profile alone has to move this polyline too, or the centreline
 * that `extractWallSegmentsForStorey` and the snap engine prefer is left behind.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { asExpressIdRef, readAttributes } from './placement-core.js';

/**
 * The two IfcCartesianPoints of a wall's `Axis` polyline (`addWallToStore`
 * writes one, Start -> End in the wall's frame), or null for a wall without.
 */
function wallAxisPointIds(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): [number, number] | null {
  const productShapeId = asExpressIdRef(readAttributes(dataStore, view, editor, expressId)?.[6]);
  const reps = productShapeId === null ? null : readAttributes(dataStore, view, editor, productShapeId)?.[2];
  if (!Array.isArray(reps)) return null;
  for (const ref of reps) {
    const rep = asExpressIdRef(ref) === null ? null : readAttributes(dataStore, view, editor, asExpressIdRef(ref)!);
    // IfcShapeRepresentation: [1] RepresentationIdentifier, [3] Items.
    if (!rep || rep[1] !== 'Axis' || !Array.isArray(rep[3])) continue;
    const polylineId = asExpressIdRef(rep[3][0]);
    const points = polylineId === null ? null : readAttributes(dataStore, view, editor, polylineId)?.[0];
    if (!Array.isArray(points) || points.length !== 2) return null;
    const [from, to] = [asExpressIdRef(points[0]), asExpressIdRef(points[1])];
    return from !== null && to !== null ? [from, to] : null;
  }
  return null;
}

/**
 * Point the wall's `Axis` polyline at `[0, 0]` .. `[length, 0]` (the wall's
 * frame after a resize, whose origin is the new Start). A wall without an Axis
 * is left as it is. `length` is in the wall's native unit.
 */
export function moveWallAxis(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  length: number,
): void {
  const axis = wallAxisPointIds(dataStore, view, editor, expressId);
  if (!axis) return;
  editor.setPositionalAttribute(axis[0], 0, [0, 0]);
  editor.setPositionalAttribute(axis[1], 0, [length, 0]);
}
