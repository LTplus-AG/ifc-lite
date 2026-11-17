/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';

/** Toast actions fetch their implementation only when the action is clicked. */
export function loadStoreyToastAction(run: (actions: typeof import('./storey-toast-actions')) => void): void {
  void import('./storey-toast-actions').then(run).catch((error: unknown) => {
    toast.error(resolve('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
  });
}

/** Capture this structural edit, so Undo can never consume a later one. */
export function storeyUndoAction(modelId: string) {
  const state = useViewerStore.getState();
  const top = state.undoStacks.get(modelId)?.at(-1);
  const step = top ? state.mutationBatchTags.get(top.id) ?? top.id : null;
  return {
    label: resolve('storeyManager.undo'), dismiss: false,
    onClick: () => loadStoreyToastAction(actions => actions.undoCopiedStoreys(modelId, step, 'storeyManager.undoStale')),
  };
}
