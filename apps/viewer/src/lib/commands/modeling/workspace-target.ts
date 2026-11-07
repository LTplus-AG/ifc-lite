/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure workspace target resolution, shared by entry and palette prerequisites (#8947). */
import type { ViewerState } from '@/store';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { selectEffectiveStoreyId } from './effective-storeys';

function resolveModelId(s: ViewerState, preferred: string | undefined): string | null {
  const candidates = [preferred, s.activeModelId ?? undefined, s.models.keys().next().value];
  return candidates.find((id): id is string => id !== undefined && s.models.get(id)?.ifcDataStore != null) ?? null;
}

function selectedRef(s: ViewerState): { modelId: string; expressId: number } | null {
  // The store's own resolver first (it knows overlay-allocated ids), then the
  // offset ranges — `resolveEntityRef`'s order, without importing the store.
  if (s.selectedEntityId === null) return null;
  return s.resolveGlobalIdFromModels(s.selectedEntityId) ?? fromGlobalIdFromModels(s.models, s.selectedEntityId) ?? null;
}

/** The storey the selection sits on (or is), in `modelId`. */
function selectionStorey(s: ViewerState, modelId: string): number | null {
  const ref = selectedRef(s);
  const hierarchy = s.models.get(modelId)?.ifcDataStore?.spatialHierarchy;
  if (!ref || ref.modelId !== modelId || !hierarchy) return null;
  if (hierarchy.storeyElevations.has(ref.expressId)) return ref.expressId;
  return hierarchy.elementToStorey.get(ref.expressId) ?? null;
}

export function modelWorkspaceTarget(s: ViewerState, opts: { modelId?: string; storeyId?: number } = {}) {
  const modelId = resolveModelId(s, opts.modelId ?? selectedRef(s)?.modelId);
  const store = modelId ? s.models.get(modelId)?.ifcDataStore : null;
  if (!modelId || !store) return null;
  const preferred = opts.storeyId ?? selectionStorey(s, modelId) ?? null;
  return { modelId, storeyId: selectEffectiveStoreyId(store, s.mutationViews.get(modelId), preferred) };
}
