/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState, FederatedModel } from '@/store';

function modelSource(model: FederatedModel) {
  return { store: model.ifcDataStore, source: model.ifcDataStore?.source, loadedAt: model.loadedAt,
    idOffset: model.idOffset, file: model.sourceFile, hash: model.sourceContentHash,
    landXml: model.landXmlDocument, geometry: model.ifcDataStore ? null : model.geometryResult };
}
/** Session ownership uses parsed/load identities, not labels or sampled file names (#7257). */
export function captureSceneSources(state: ViewerState) {
  return { valid: true, models: new Map([...state.models].map(([id, model]) => [id, modelSource(model)])),
    single: state.models.size === 0 ? { store: state.ifcDataStore, source: state.ifcDataStore?.source,
      geometry: state.ifcDataStore ? null : state.geometryResult } : null };
}
export type SceneSources = ReturnType<typeof captureSceneSources>;
/** A source that disappeared cannot regain the old application's ownership by returning later. */
export function sceneSourcesAreCurrent(captured: SceneSources, state: ViewerState): boolean {
  if (!captured.valid) return false;
  const matches = captured.models.size === state.models.size && [...captured.models].every(([id, saved]) => {
    const model = state.models.get(id);
    if (!model) return false;
    const current = modelSource(model);
    return current.store === saved.store && current.source === saved.source && current.loadedAt === saved.loadedAt
      && current.idOffset === saved.idOffset && current.file === saved.file && current.hash === saved.hash
      && current.landXml === saved.landXml && current.geometry === saved.geometry;
  }) && (!captured.single || (state.ifcDataStore === captured.single.store
    && state.ifcDataStore?.source === captured.single.source
    && (state.ifcDataStore ? null : state.geometryResult) === captured.single.geometry));
  if (!matches) captured.valid = false;
  return matches;
}
