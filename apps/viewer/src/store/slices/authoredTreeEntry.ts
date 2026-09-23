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
import type { MeshData } from '@ifc-lite/geometry';
import type { NewEntity } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';

type ModelState = Pick<ViewerState, 'models' | 'ifcDataStore' | 'activeModelId'>;

/**
 * The data store an overlay edit on `modelId` lands in. In single-model
 * (legacy) mode `models` is empty and the store lives on the top-level
 * `ifcDataStore`, under the `__legacy__` mutation id.
 */
export function authoredDataStore(state: ModelState, modelId: string): IfcDataStore | null {
  return state.models.get(modelId)?.ifcDataStore ?? (state.models.size === 0 ? state.ifcDataStore : null);
}

/**
 * Put an authored element's mesh on screen. `appendGeometryBatch` only routes
 * to a known model or the active one, and legacy mode has neither, so there
 * the top-level geometry is extended directly.
 */
export function appendAuthoredMesh(state: ModelState & Pick<ViewerState, 'appendGeometryBatch' | 'geometryResult' | 'setGeometryResult'>, modelId: string, mesh: MeshData): void {
  if (state.models.size > 0 || !state.geometryResult) {
    state.appendGeometryBatch(modelId, [mesh]);
    return;
  }
  const g = state.geometryResult;
  state.setGeometryResult({
    ...g,
    meshes: [...g.meshes, mesh],
    totalTriangles: g.totalTriangles + mesh.indices.length / 3,
    totalVertices: g.totalVertices + mesh.positions.length / 3,
  });
}

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
  state: ModelState,
  modelId: string,
  entityId: number,
  record: NewEntity | null | undefined,
  exists: boolean,
): void {
  const hierarchy = authoredDataStore(state, modelId)?.spatialHierarchy;
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
