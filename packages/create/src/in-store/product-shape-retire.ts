/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** ShapeOfProduct is mandatory and a shape representation has exactly one owner (IfcShapeModel WR11),
 * so a product shape nothing points at any more is removed with the representation records only it reached. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { effectiveReferencers } from '@ifc-lite/export';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';

const OWNED_SLOTS: Readonly<Record<string, readonly number[]>> = {
  IFCPRODUCTDEFINITIONSHAPE: [2],
  IFCSHAPEREPRESENTATION: [3],
  IFCMAPPEDITEM: [0, 1],
  IFCREPRESENTATIONMAP: [0, 1],
};

const RETIRE_WORK_LIMIT = 100_000;

function slotRefs(value: unknown): number[] {
  return (Array.isArray(value) ? value : [value]).map(refId).filter((id): id is number => id !== null);
}

/** Removes `shapeId` and what only it reached, inside the edit that re-pointed or removed the product; returns the removed ids. */
export function retireProductShape(store: IfcDataStore, editor: StoreEditor, shapeId: number): number[] {
  const view = editor.getMutationView();
  const reader = new AnchorEntityReader(store, view);
  const removed: number[] = [];
  const pending = [shapeId];
  let work = 0;
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (++work > RETIRE_WORK_LIMIT) throw new Error(`Retiring product shape #${shapeId} exceeds its work budget`);
    const entity = reader.entity(id);
    if (!entity || entity.names.includes('GlobalId')) continue;
    if (effectiveReferencers(store, view)(id).length > 0) continue;
    if (!editor.removeEntity(id)) continue;
    removed.push(id);
    for (const slot of OWNED_SLOTS[entity.type.toUpperCase()] ?? []) pending.push(...slotRefs(entity.attributes[slot]));
  }
  return removed;
}
