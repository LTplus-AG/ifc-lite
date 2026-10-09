/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Navigation provenance starts where the native comparison reads its sources,
 * never at a later panel mount (#7307). Unverifiable imported/manual results
 * keep their facts, but cannot acquire this lease by being rendered. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types';
import type { ViewerState } from '@/store';
import type { BuiltPair } from '@/hooks/compare/comparePairCache';
import type { CompareResult } from '@/store/slices/compareSlice';

export function comparisonNavigationInputs(models: readonly FederatedModel[], getView: (id: string) => MutablePropertyView | null,
  geometryVersion: number) {
  const pins = models.map(model => {
    const view = getView(model.id);
    return { modelId: model.id, model, entities: model.ifcDataStore?.entities,
      fingerprint: model.sourceFingerprint, hash: model.sourceContentHash, view,
      revision: view?.getMutationRevision() ?? null };
  });
  return {
    getView: (id: string) => pins.find(pin => pin.modelId === id)?.view ?? null,
    preparedIsCurrent: () => pins.every(pin => pin.model.ifcDataStore?.entities === pin.entities
      && pin.model.sourceFingerprint === pin.fingerprint && pin.model.sourceContentHash === pin.hash
      && getView(pin.modelId) === pin.view && (pin.view?.getMutationRevision() ?? null) === pin.revision),
    current: (state: Pick<ViewerState, 'models' | 'mutationViews' | 'geometryContentVersion'>) =>
      state.geometryContentVersion === geometryVersion && pins.every(pin => {
        const model = state.models.get(pin.modelId), view = state.mutationViews.get(pin.modelId) ?? null;
        return !!model && model.ifcDataStore?.entities === pin.entities
          && model.sourceFingerprint === pin.fingerprint && model.sourceContentHash === pin.hash
          && view === pin.view && (view?.getMutationRevision() ?? null) === pin.revision;
      }),
  };
}
type Lease = ReturnType<typeof comparisonNavigationInputs>;
const prepared = new WeakMap<BuiltPair, Lease>();
const results = new WeakMap<CompareResult, Lease>();
export function rememberPreparedNavigation(built: BuiltPair, lease: Lease): void {
  if (lease.preparedIsCurrent()) prepared.set(built, lease);
}
export function rememberComparisonNavigation(result: CompareResult, built: BuiltPair): void {
  const lease = prepared.get(built);
  if (lease?.preparedIsCurrent()) results.set(result, lease);
}
export function comparisonNavigationIsCurrent(result: CompareResult, state: ViewerState): boolean {
  return results.get(result)?.current(state) === true;
}
