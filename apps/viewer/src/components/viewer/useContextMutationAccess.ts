/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react';
import { useViewerStore } from '@/store';
import type { ViewerState } from '@/store';
import type { EntityRef } from '@/store/types';
import { canMutate, mutationDenialKey, mutationPermission } from '@/store/mutation-permission';
import { getOrCreateMutationView, normalizeMutationModelId } from '@/sdk/adapters/mutation-view';

/**
 * Whether an entity of `modelId` may be edited from a UI entry point: the
 * shared mutation permission (Edit mode, collab role, editable model) AND a
 * live mutation view. The context menu and the Ctrl/⌘+D shortcut both ask
 * this, so they cannot disagree (#6233).
 */
export function entityMutationAccess(state: ViewerState, modelId: string) {
  const permission = mutationPermission(state, modelId);
  const hasView = state.mutationViews.has(normalizeMutationModelId(state, modelId));
  return {
    canEdit: permission.allowed && hasView,
    hasView,
    editReasonKey: permission.allowed ? undefined : mutationDenialKey(permission.reason),
  };
}

/** Create the model's on-demand editable view when editing is allowed (#5901). */
export function ensureEntityMutationView(modelId: string): void {
  const state = useViewerStore.getState();
  if (!canMutate(state, modelId)) return;
  if (!state.mutationViews.has(normalizeMutationModelId(state, modelId))) getOrCreateMutationView(useViewerStore, modelId);
}

/** Context actions share the Properties panel's on-demand editable view (#5901). */
export function useContextMutationAccess(ref: EntityRef | null, isOpen: boolean) {
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const collabRole = useViewerStore((s) => s.collabRole);
  const models = useViewerStore((s) => s.models);

  useEffect(() => {
    if (isOpen && ref) ensureEntityMutationView(ref.modelId);
  }, [isOpen, ref, mutationViews, editEnabled, collabRole, models]);

  const access = useMemo(() => ref ? entityMutationAccess(useViewerStore.getState(), ref.modelId) : null,
    // mutationViews, editEnabled, collabRole and models are what the access reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ref, mutationViews, editEnabled, collabRole, models]);
  return {
    canEdit: access?.canEdit === true,
    editReasonKey: access?.editReasonKey,
    showMutationActions: !!ref && (access?.hasView === true || !!access?.editReasonKey),
  };
}
