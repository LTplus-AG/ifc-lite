/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { extractProjectUnits, ProjectUnits } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import type { RenderFrameOffsets } from '@/components/viewer/tools/measure-modes/coordinates';
import { createListDataProvider } from './index';
import type { ModelProviderPair } from './run-list';
import { makeWorldPositionGetter } from '../geo/entity-world-position';
import { zoneVolumeSiScale } from '../units/zone-volume-scale';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';

export type ListProviderState = Pick<ViewerState,
  'models' | 'ifcDataStore' | 'geometryResult' | 'zoneSets' | 'zoneAssignments' |
  'zoneApportionment' | 'toGlobalId' | 'mutationViews'>;

/** The provider inputs are explicit so document export does not depend on mounted panels. */
export function prepareListProviders(state: ListProviderState, renderFrame: RenderFrameOffsets) {
  const pairs: ModelProviderPair[] = [];
  const entries = state.models.size > 0
    ? [...state.models].flatMap(([modelId, model]) => model.ifcDataStore
      ? [{ modelId, store: model.ifcDataStore, name: model.name, geometry: model.geometryResult ?? state.geometryResult, view: state.mutationViews.get(modelId) }] : [])
    : state.ifcDataStore ? [{ modelId: 'default', store: state.ifcDataStore, name: '', geometry: state.geometryResult,
      view: state.mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? state.mutationViews.get(LEGACY_MODEL_ID) }] : [];
  const modelUnits = new Map<string, ProjectUnits>();
  for (const { modelId, store, name, geometry, view } of entries) {
    const units = store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty();
    modelUnits.set(modelId, units);
    const toGlobalId = (expressId: number) => state.toGlobalId(modelId, expressId);
    const zoneContext = {
      zoneSets: state.zoneSets, zoneAssignments: state.zoneAssignments, apportionment: state.zoneApportionment,
      volumeSiScale: store.source.length > 0 ? zoneVolumeSiScale(units) : 1, toGlobalId,
      getWorldPosition: makeWorldPositionGetter(store, geometry, renderFrame, toGlobalId),
    };
    pairs.push({ modelId, store, mutationView: view, provider: createListDataProvider(store, name, zoneContext, view) });
  }
  return { pairs, providers: pairs.map((pair) => pair.provider), stores: pairs.map((pair) => pair.store), modelUnits, hasData: pairs.length > 0 };
}
