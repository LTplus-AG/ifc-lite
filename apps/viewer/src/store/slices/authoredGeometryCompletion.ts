/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Visible geometry after an authored edit, independently of its history format (#6592). */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import type { AuthoredElement } from './authoredElement.js';
import { rememberAuthoredElement, remeshAuthoredElement } from './authoredFallbackMesh.js';

/** Occurrence meshes are hidden in Types view; reveal a newly authored occurrence. */
export function revealAddedGeometryInModelView(get: () => ViewerState): void {
  const state = get();
  if (state.typeViewMode === 'types') state.setTypeViewMode('model');
}

/** Use native geometry, with the normal parameter fallback when native meshing declines. */
export function completeAuthoredGeometry(
  get: () => ViewerState,
  modelId: string,
  dataStore: IfcDataStore,
  storeyExpressId: number,
  entityId: number,
  element: AuthoredElement,
): void {
  rememberAuthoredElement(dataStore, entityId, storeyExpressId, element);
  void remeshAuthoredElement(get, modelId, entityId);
  revealAddedGeometryInModelView(get);
}
