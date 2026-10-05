/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element references for the `checks` pack adapters (#6833): a federated
 * renderer id resolved back to its model, local express id, IFC GlobalId and
 * class through the store's canonical resolvers. An id no loaded model owns
 * stays unresolved (`modelId`/`expressId`/`globalId` null), never guessed.
 */

import type { ViewerState } from '@/store';

export interface EvidenceEntityRef {
  modelId: string | null;
  globalId: string | null;
  expressId: number | null;
  type: string | null;
  /** The federated renderer id the native result recorded. */
  renderId: number;
}

type EntityStore = { entities?: { getGlobalId(id: number): string; getTypeName(id: number): string } } | null | undefined;

function describe(store: EntityStore, modelId: string | null, expressId: number, renderId: number): EvidenceEntityRef {
  return { modelId, expressId, renderId,
    globalId: store?.entities?.getGlobalId(expressId) || null,
    type: store?.entities?.getTypeName(expressId) || null };
}

/** Resolve a federated id against every loaded model (`resolveGlobalIdFromModels`). */
export function entityRefOf(state: ViewerState, renderId: number): EvidenceEntityRef {
  // Legacy single-store mode (no federation): renderer id === express id.
  if (state.models.size === 0) return describe(state.ifcDataStore, null, renderId, renderId);
  const hit = state.resolveGlobalIdFromModels(renderId);
  if (!hit) return { modelId: null, globalId: null, expressId: null, type: null, renderId };
  return describe(state.models.get(hit.modelId)?.ifcDataStore, hit.modelId, hit.expressId, renderId);
}

/** Resolve a federated id within the model a native result names (`resolveGlobalIdInModel`). */
export function entityRefInModel(state: ViewerState, modelId: string, renderId: number): EvidenceEntityRef {
  const hit = state.resolveGlobalIdInModel(modelId, renderId);
  if (!hit) return { modelId, globalId: null, expressId: null, type: null, renderId };
  return describe(state.models.get(hit.modelId)?.ifcDataStore, hit.modelId, hit.expressId, renderId);
}
