/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grid-bound placements in the storey placement tree (#9013).
 *
 * An IfcGridPlacement has no PlacementRelTo before IFC4X3: it sits on the
 * intersection of two grid axes, so it follows the grid's own ObjectPlacement.
 * The storey planner treats that grid placement as the grid placement's
 * parent, so a product bound to a moved grid is found and either moves with
 * it (same storey) or is refused (another storey: a grid placement cannot be
 * compensated by a local offset).
 */

import type { AnchorEntityReader } from '../resolve-anchor.js';
import { refId } from '../host-geometry-frame.js';

type Reader = Pick<AnchorEntityReader, 'entity'>;
type Referencers = (id: number) => readonly number[];

function attribute(reader: Reader, id: number, name: string): unknown {
  const entity = reader.entity(id);
  if (!entity) return undefined;
  const index = entity.names.indexOf(name);
  return index < 0 ? undefined : entity.attributes[index];
}

function refs(value: unknown): number[] {
  return (Array.isArray(value) ? value : [value]).map(refId).filter((id): id is number => id !== null);
}

/** The IfcGrid owning `axisId`, or null. */
function gridOfAxis(reader: Reader, referencers: Referencers, axisId: number): number | null {
  for (const parent of referencers(axisId)) {
    if (reader.entity(parent)?.type.toUpperCase() !== 'IFCGRID') continue;
    if (['UAxes', 'VAxes', 'WAxes'].some((name) => refs(attribute(reader, parent, name)).includes(axisId))) return parent;
  }
  return null;
}

/**
 * The placement a grid placement follows: its PlacementRelTo (IFC4X3), else
 * the ObjectPlacement of the grid its location's axes belong to. Null when
 * neither can be read.
 */
export function gridPlacementParent(reader: Reader, referencers: Referencers, gridPlacementId: number): number | null {
  const explicit = refId(attribute(reader, gridPlacementId, 'PlacementRelTo'));
  if (explicit !== null) return explicit;
  const intersection = refId(attribute(reader, gridPlacementId, 'PlacementLocation'));
  if (intersection === null) return null;
  for (const axis of refs(attribute(reader, intersection, 'IntersectingAxes'))) {
    const grid = gridOfAxis(reader, referencers, axis);
    if (grid !== null) return refId(reader.entity(grid)?.attributes[5]);
  }
  return null;
}

/** Every IfcGridPlacement located on `gridId`'s axes. */
export function gridPlacementsOn(reader: Reader, referencers: Referencers, gridId: number): number[] {
  const placements = new Set<number>();
  const axes = ['UAxes', 'VAxes', 'WAxes'].flatMap((name) => refs(attribute(reader, gridId, name)));
  for (const axis of axes) {
    for (const intersection of referencers(axis)) {
      if (reader.entity(intersection)?.type.toUpperCase() !== 'IFCVIRTUALGRIDINTERSECTION') continue;
      for (const placement of referencers(intersection)) {
        if (reader.entity(placement)?.type.toUpperCase() !== 'IFCGRIDPLACEMENT') continue;
        if (refId(attribute(reader, placement, 'PlacementLocation')) === intersection) placements.add(placement);
      }
    }
  }
  return [...placements];
}
