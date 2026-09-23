/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps an authored element's spatial-tree row in step with whether the
 * element exists. `registerAuthoredElement` adds the row when an add* action
 * builds it; every later transition (remove, undo of the add, redo of the
 * remove, and their inverses) has to take it out or put it back, or the tree
 * lists an element the model no longer holds.
 */

import type { SpatialHierarchy, SpatialNode } from '@ifc-lite/data';
import type { NewEntity } from '@ifc-lite/mutations';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';

function dropChild(node: SpatialNode, entityId: number): boolean {
  const index = node.children.findIndex((child) => child.expressId === entityId);
  if (index >= 0) {
    node.children.splice(index, 1);
    return true;
  }
  return node.children.some((child) => dropChild(child, entityId));
}

/**
 * Take an authored element's row out of the tree. `elementToStorey` is kept:
 * it is where a later undo / redo reads the storey to put the row back, and a
 * removed element resolving a storey is harmless.
 */
export function unregisterAuthoredElement(hierarchy: SpatialHierarchy, entityId: number): void {
  const storeyId = hierarchy.elementToStorey.get(entityId);
  if (storeyId === undefined) return;
  const contained = hierarchy.byStorey.get(storeyId);
  const index = contained?.indexOf(entityId) ?? -1;
  if (contained && index >= 0) contained.splice(index, 1);
  if (dropChild(hierarchy.project, entityId)) hierarchy.bySpace.delete(entityId);
}

/**
 * Sync the row for an overlay-authored element: `record` is its overlay record
 * when it now exists, `null` when it is gone. Source-file entities (no record
 * either side) and elements the tree never listed are left alone.
 */
export function syncAuthoredTreeEntry(
  models: ReadonlyMap<string, { ifcDataStore?: { spatialHierarchy?: SpatialHierarchy | null } | null }>,
  modelId: string,
  entityId: number,
  record: NewEntity | null | undefined,
  exists: boolean,
): void {
  const hierarchy = models.get(modelId)?.ifcDataStore?.spatialHierarchy;
  if (!hierarchy || !record) return;
  if (!exists) {
    unregisterAuthoredElement(hierarchy, entityId);
    return;
  }
  const storeyId = hierarchy.elementToStorey.get(entityId);
  if (storeyId === undefined) return;
  const rawName = record.attributes?.[2];
  registerAuthoredElement(hierarchy, storeyId, entityId, record.type, typeof rawName === 'string' ? rawName : '');
}
