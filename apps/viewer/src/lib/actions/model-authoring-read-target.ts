/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { configureMutationView } from '@/utils/configureMutationView';

export type NativeReadState = Pick<ViewerState, 'models' | 'mutationViews'>;
export interface NativeReadLease { target: ModelEditTarget; validate(): void }

/** Detached native read facade: even StoreEditor's allocator watermark stays off the live overlay. */
export function readOnlyModelEditTarget(state: NativeReadState, modelId: string): ModelEditTarget | null {
  return readOnlyModelEditLease(state, modelId)?.target ?? null;
}

/** Retain the canonical snapshot's validation for explicit attachment ownership. */
export function readOnlyModelEditLease(state: NativeReadState, modelId: string): NativeReadLease | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore?.entityIndex?.byId || !dataStore.entityIndex.byType) return null;
  const live = state.mutationViews.get(modelId);
  if (live) {
    // prepareAtomic owns the canonical complete snapshot, including skip-history changes.
    // No commit occurs; no draft identity, watermark or cache is published to the viewer.
    const prepared = live.prepareAtomic(view => ({ modelId, dataStore, view, editor: new StoreEditor(dataStore, view) }));
    return { target: prepared.result, validate: prepared.validate };
  }
  const view = new MutablePropertyView(dataStore.properties ?? null, modelId);
  configureMutationView(view, dataStore);
  return { target: { modelId, dataStore, view, editor: new StoreEditor(dataStore, view) }, validate: () => {} };
}

/** One native snapshot per source within a bounded evidence capture, never a cross-revision cache. */
export function nativeReadTargets(state: NativeReadState): (modelId: string) => ModelEditTarget | null {
  const targets = new Map<string, ModelEditTarget | null>();
  return modelId => {
    if (!targets.has(modelId)) targets.set(modelId, readOnlyModelEditTarget(state, modelId));
    return targets.get(modelId) ?? null;
  };
}
