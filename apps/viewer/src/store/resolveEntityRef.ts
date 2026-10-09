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
import { federationRegistry } from '@ifc-lite/renderer';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
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

  // A #5050 streamed federation publishes one component at a time after its
  // range has been reserved, but before its final semantic document is ready
  // to enter `models`. Preserve store/overlay precedence above; only this
  // short-lived, published-but-not-yet-installed window needs the registry.
  // Without it a pick on the new component is attributed to the anchor by the
  // single-model fallback below.
  const progressive = federationRegistry.fromGlobalId(globalId);
  if (progressive) return progressive;

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
  const modelGlobalId = resolveEntityRefGlobalIdFromState(state, entityRef);
  if (modelGlobalId) return modelGlobalId;

  const resolvedModel = entityRef.modelId === 'legacy' ? undefined : state.models.get(entityRef.modelId);
  if (resolvedModel?.ifcDataStore) return null;

  // Preserve the public single-store compatibility path while a registered
  // model is still hydrating its own data store. Exact EntityRef callers must
  // remain model-bound and therefore deliberately do not use this fallback.
  return state.ifcDataStore?.entities.getGlobalId(entityRef.expressId) ?? null;
}

/** Resolve an exact model-space ref without losing identity to overlapping
 * renderer-id ranges. Parsed and StoreEditor-created entities share this path. */
export function resolveEntityRefGlobalId(entityRef: EntityRef): string | null {
  return resolveEntityRefGlobalIdFromState(useViewerStore.getState(), entityRef);
}

/** Snapshot-aware variant for transactions that must not follow a model
 * replacement while awaiting other work. */
export function resolveEntityRefGlobalIdFromState(
  state: Pick<ReturnType<typeof useViewerStore.getState>, 'models' | 'ifcDataStore' | 'mutationViews'>,
  entityRef: EntityRef,
): string | null {
  const dataStore = entityRef.modelId === 'legacy'
    ? state.ifcDataStore
    : state.models.get(entityRef.modelId)?.ifcDataStore;
  const mutationView = state.mutationViews.get(entityRef.modelId);
  // #7282: the canonical schema record owns named/positional precedence,
  // current Root role and tombstones. Non-Root attribute 0 is never GlobalId.
  if (!dataStore) return null;
  // Immutable parsed columns already enforce the schema's Root-only identity
  // contract. Source-only/cached identity reads need no graph hydration.
  if (!mutationView) {
    const identity = dataStore.entities.getGlobalId(entityRef.expressId);
    return typeof identity === 'string' && identity.length > 0 ? identity : null;
  }
  const record = effectiveMetadataRecord(dataStore, entityRef.expressId, mutationView);
  if (!record || record.names[0] !== 'GlobalId') return null;
  const nativeIdentity = mutationView?.getNewEntity(entityRef.expressId)
    || mutationView?.getPositionalMutationsForEntity(entityRef.expressId)?.has(0)
    || mutationView?.getAttributeMutationsForEntity(entityRef.expressId).some(row => row.name === 'GlobalId');
  // Cached source-free columns retain known immutable identities; missing
  // graph attributes never make those names into current geometry evidence.
  const globalId = nativeIdentity ? record.attributes[0] : dataStore.entities.getGlobalId(entityRef.expressId);
  return typeof globalId === 'string' && globalId.length > 0 ? globalId : null;
}
