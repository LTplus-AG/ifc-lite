/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Send collaborators the new shape of an element reshaped in place (#6233).
 *
 * Locally, a reshaped element is re-meshed by the wasm re-mesh service
 * (`requestRemesh`, #6297). Peers get a mesh built from the element's builder
 * params instead, drawn through its storey's authoring frame — the same path
 * `addWall` & co. mirror a new element with — so it lands where it reloads,
 * on an offset storey too. One helper for every in-place reshape: a wall
 * resize (`refreshWallMeshIn`) and the piece a split keeps.
 */

import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { buildElementMesh } from './addElementMeshes.js';
import { authoredElementMeshPayloadOnStorey, type AuthoredElement } from './authoredElement.js';
import { effectiveStoreyId } from '@/lib/effective-storey.js';

/** Mirror `expressId`'s shape, described as `element`'s builder params (storey-local metres). */
export function mirrorAuthoredGeometry(get: () => ViewerState, modelId: string, expressId: number, element: AuthoredElement): void {
  const model = get().models.get(modelId);
  const dataStore = model?.ifcDataStore;
  // The live storey (queued containment edits count), as the split commit reads it.
  const storeyId = dataStore ? effectiveStoreyId(dataStore, get().mutationViews.get(modelId), expressId) : undefined;
  if (!dataStore || storeyId === undefined) return;
  const mesh = buildElementMesh({
    type: element.kind,
    globalId: toGlobalIdFromModels(get().models, modelId, expressId),
    storeyElevation: dataStore.spatialHierarchy?.storeyElevations?.get(storeyId) ?? 0,
    payload: authoredElementMeshPayloadOnStorey(element, dataStore, storeyId, model?.geometryResult?.coordinateInfo),
  });
  if (mesh) get().mirrorEntityGeometry(modelId, expressId, mesh);
}
