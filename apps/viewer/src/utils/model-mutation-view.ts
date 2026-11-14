/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { configureMutationView } from './configureMutationView.js';

/** Same ownership floor for live overlays and allocating cold planners. */
export function modelExpressIdFloor(modelId: string, source: IfcDataStore | null): () => number {
  const watermark = source?.entityIndex?.byId ? highestExistingExpressId(source) : 0;
  return () => {
    const range = federationRegistry.getGlobalIdRange(modelId);
    const offset = federationRegistry.getOffset(modelId);
    return Math.max(watermark, range && offset !== null ? range.end - offset : 0) + 1;
  };
}

export function createModelMutationView(dataStore: IfcDataStore, modelId: string): MutablePropertyView {
  const view = new MutablePropertyView(dataStore.properties ?? null, modelId);
  view.configureExpressIdAllocator(modelExpressIdFloor(modelId, dataStore));
  configureMutationView(view, dataStore);
  return view;
}

/** Source-only views carry no work to reload, and must not retain an old allocator floor. */
export function discardUnchangedMutationViews(state: Partial<Pick<import('@/store').ViewerState, 'mutationViews' | 'clearMutationView'>>): void {
  const modelIds = [...state.mutationViews ?? []]
    .filter(([, view]) => !view.hasPendingChanges() && view.getMutationCount() === 0)
    .map(([modelId]) => modelId);
  if (modelIds.length) state.clearMutationView?.(modelIds);
}
