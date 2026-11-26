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
import type { ViewerState } from './index.js';
import { getViewerState } from './viewerStoreHandle.js';

/** Resolve a renderer/global ID against one consistent Viewer store snapshot. */
function resolveEntityRefFromState(
  state: ViewerState,
  globalId: number,
): EntityRef {
  const resolved = state.resolveGlobalIdFromModels(globalId);
  if (resolved) {
    return { modelId: resolved.modelId, expressId: resolved.expressId };
  }

  // A streaming model can publish geometry before its semantic document or
  // final parse range enters the store (#5050). Require published ownership.
  const published = federationRegistry.fromGlobalId(globalId);
  if (published) return published;

  // Legacy single-model mode or an ID with no known owner.
  // 'legacy' is recognized by PropertiesPanel for fallback to legacy ifcDataStore.
  return { modelId: 'legacy', expressId: globalId };
}

/**
 * Resolve a globalId (renderer-space) to an EntityRef (model-space).
 *
 * Resolution order:
 *  1. resolveGlobalIdFromModels (offset-based range check — the canonical path)
 *  2. The federation registry for published IDs outside the store ranges
 *  3. 'legacy' sentinel for legacy single-model mode or an unowned ID
 *
 * ALWAYS returns an EntityRef — never null.  This ensures all callers
 * (multi-select, basket, context menu) can proceed without null-guards.
 */
export function resolveEntityRef(globalId: number): EntityRef {
  return resolveEntityRefFromState(getViewerState(), globalId);
}

/**
 * Resolve a renderer/global ID to its GlobalId string.
 *
 * This builds on {@link resolveEntityRef}, so federation offsets, legacy
 * single-model mode, and overlay-created entities all use the same canonical
 * renderer ID resolution path.
 */
export function resolveGlobalId(globalId: number): string | null {
  const state = getViewerState();
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
  return resolveEntityRefGlobalIdFromState(getViewerState(), entityRef);
}

/** Snapshot-aware variant for transactions that must not follow a model
 * replacement while awaiting other work. */
export function resolveEntityRefGlobalIdFromState(
  state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews'>,
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
