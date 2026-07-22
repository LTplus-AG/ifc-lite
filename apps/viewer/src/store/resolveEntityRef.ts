/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for resolving a globalId to an EntityRef.
 *
 * Every code path that needs an EntityRef from a globalId MUST use this
 * function.  It guarantees consistent modelId values so that basket
 * add/remove keys always match, regardless of which UI surface triggered
 * the selection.
 */

import type { EntityRef } from './types.js';
import { useViewerStore } from './index.js';

/** Resolve a renderer/global ID against one consistent Viewer store snapshot. */
function resolveEntityRefFromState(
  state: ReturnType<typeof useViewerStore.getState>,
  globalId: number,
): EntityRef {
  const resolved = state.resolveGlobalIdFromModels(globalId);
  if (resolved) {
    return { modelId: resolved.modelId, expressId: resolved.expressId };
  }

  // Fallback: single-model mode where offset is 0 → globalId === expressId
  if (state.models.size > 0) {
    const firstModelId = state.models.keys().next().value as string;
    return { modelId: firstModelId, expressId: globalId };
  }

  // Legacy single-model mode: no models in federation map yet.
  // 'legacy' is recognized by PropertiesPanel for fallback to legacy ifcDataStore.
  return { modelId: 'legacy', expressId: globalId };
}

/**
 * Resolve a globalId (renderer-space) to an EntityRef (model-space).
 *
 * Resolution order:
 *  1. resolveGlobalIdFromModels (offset-based range check — the canonical path)
 *  2. First loaded model as fallback (single-model, offset 0)
 *  3. 'legacy' sentinel for truly legacy single-model mode (no federation map)
 *
 * ALWAYS returns an EntityRef — never null.  This ensures all callers
 * (multi-select, basket, context menu) can proceed without null-guards.
 */
export function resolveEntityRef(globalId: number): EntityRef {
  return resolveEntityRefFromState(useViewerStore.getState(), globalId);
}

/**
 * Resolve a renderer/global ID to its GlobalId string.
 *
 * This builds on {@link resolveEntityRef}, so federation offsets, legacy
 * single-model mode, and overlay-created entities all use the same canonical
 * renderer ID resolution path.
 */
export function resolveGlobalId(globalId: number): string | null {
  const state = useViewerStore.getState();
  const entityRef = resolveEntityRefFromState(state, globalId);
  const dataStore = state.models.get(entityRef.modelId)?.ifcDataStore ?? state.ifcDataStore;
  const resolvedGlobalId = dataStore?.entities.getGlobalId(entityRef.expressId);
  if (resolvedGlobalId) return resolvedGlobalId;

  const overlayGlobalId = state.getMutationView(entityRef.modelId)?.getNewEntity(entityRef.expressId)?.attributes[0];
  return typeof overlayGlobalId === 'string' && overlayGlobalId.length > 0 ? overlayGlobalId : null;
}
