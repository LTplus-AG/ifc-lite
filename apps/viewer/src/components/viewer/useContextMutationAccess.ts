/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react';
import { useViewerStore } from '@/store';
import type { EntityRef } from '@/store/types';
import { canMutate, mutationDenialKey, mutationPermission } from '@/store/mutation-permission';
import { getOrCreateMutationView, normalizeMutationModelId } from '@/sdk/adapters/mutation-view';

/** Context actions share the Properties panel's on-demand editable view (#5901). */
export function useContextMutationAccess(ref: EntityRef | null, isOpen: boolean) {
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const collabRole = useViewerStore((s) => s.collabRole);
  const models = useViewerStore((s) => s.models);

  useEffect(() => {
    if (!isOpen || !ref || !canMutate(useViewerStore.getState(), ref.modelId)) return;
    const viewModelId = normalizeMutationModelId(useViewerStore.getState(), ref.modelId);
    if (!mutationViews.has(viewModelId)) getOrCreateMutationView(useViewerStore, ref.modelId);
  }, [isOpen, ref, mutationViews, editEnabled, collabRole, models]);

  const permission = useMemo(() => ref
    ? mutationPermission(useViewerStore.getState(), ref.modelId) : null,
  [ref, editEnabled, collabRole, models]);
  const hasView = ref
    ? mutationViews.has(normalizeMutationModelId(useViewerStore.getState(), ref.modelId)) : false;
  const editReasonKey = permission && !permission.allowed ? mutationDenialKey(permission.reason) : undefined;
  return {
    canEdit: permission?.allowed === true && hasView,
    editReasonKey,
    showMutationActions: !!ref && (hasView || !!editReasonKey),
  };
}
