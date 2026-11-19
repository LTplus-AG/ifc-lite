/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { configureMutationView } from './configureMutationView.js';
import { sourceWatermark } from './source-watermark.js';
import { hasPendingWorkOutsideView } from '@/store/slices/pending-outside-view';

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
  // Discard only on a proven overlap; an unknown (NaN) source end keeps the edits.
  if (lowest === 0 || !(lowest <= sourceEnd)) return lowest;
  console.warn(`[Model] Discarded kept edits of model ${modelId}: its new entities from #${lowest} overlap the loaded source, which ends at #${sourceEnd}`);
  // Only the view's entity edits overlap; georeference edits live outside it and stay.
  state.clearMutationView(modelId, { keepGeoref: true });
  return 0;
}

/** Source-only views carry no work to reload, and must not retain an old allocator floor. */
export function discardUnchangedMutationViews(state: Partial<Pick<import('@/store').ViewerState, 'mutationViews' | 'clearMutationView' | 'georefMutations' | 'scheduleSourceModelId' | 'scheduleIsEdited' | 'scheduleData'>>): void {
  // Retain views associated with unsaved georeference or schedule work as well as overlay edits.
  const modelIds = [...state.mutationViews ?? []]
    .filter(([modelId, view]) => !view.hasPendingChanges() && view.getMutationCount() === 0 && !hasPendingWorkOutsideView(state, modelId))
    .map(([modelId]) => modelId);
  if (modelIds.length) state.clearMutationView?.(modelIds);
}
