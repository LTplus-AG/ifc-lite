/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { configureMutationView } from './configureMutationView.js';

/** Highest source ID the store holds (0 without an index). */
export function sourceWatermark(source: IfcDataStore | null): number {
  return source?.entityIndex?.byId ? highestExistingExpressId(source) : 0;
}

/** Same ownership floor for live overlays and allocating cold planners. */
export function modelExpressIdFloor(modelId: string, source: IfcDataStore | null, watermark = sourceWatermark(source)): () => number {
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

/** Kept creations at or below the source end would alias source entities on
 *  every read and export path, so they are discarded. Returns the first kept
 *  creation that survives (0 for none). */
export function discardOverlappingRetainedEdits(
  state: Pick<import('@/store').ViewerState, 'mutationViews' | 'clearMutationView'>, modelId: string, sourceEnd: number,
): number {
  const lowest = state.mutationViews.get(modelId)?.getCreatedExpressIdBounds().lowest ?? 0;
  if (lowest === 0 || lowest > sourceEnd) return lowest;
  console.warn(`[Model] Discarded kept edits of model ${modelId}: its new entities from #${lowest} overlap the loaded source, which ends at #${sourceEnd}`);
  state.clearMutationView(modelId);
  return 0;
}

/** Source-only views carry no work to reload, and must not retain an old allocator floor. */
export function discardUnchangedMutationViews(state: Partial<Pick<import('@/store').ViewerState, 'mutationViews' | 'clearMutationView'>>): void {
  const modelIds = [...state.mutationViews ?? []]
    .filter(([, view]) => !view.hasPendingChanges() && view.getMutationCount() === 0)
    .map(([modelId]) => modelId);
  if (modelIds.length) state.clearMutationView?.(modelIds);
}
