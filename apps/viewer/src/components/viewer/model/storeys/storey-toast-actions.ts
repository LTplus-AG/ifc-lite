/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { activateStorey } from '@/lib/storeys/storey-session';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { mutationDenial } from '@/store/mutation-permission';
import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';

/** #9334: a persistent add toast must recheck its target when clicked. */
export function drawOnAddedStorey(modelId: string, storeyId: number): void {
  const state = useViewerStore.getState();
  if (!state.session || !modelStoreys(state, modelId).some(storey => storey.expressId === storeyId)) return;
  if ('refused' in resolveWorkplane(state, modelId, { kind: 'storey', storeyId, offset: 0 })) return;
  activateStorey(state, modelId, storeyId);
}

export function showCopiedStoreys(modelId: string): void {
  const state = useViewerStore.getState();
  if (!state.models.has(modelId)) return;
  state.clearIsolation();
  applyLevelDisplayMode('stacked');
  state.setStoreyContextMode('all');
}

export function undoCopiedStoreys(modelId: string, step: string | null): void {
  const state = useViewerStore.getState();
  const denied = mutationDenial(state, modelId);
  if (denied) { toast.error(resolve('storeyManager.copy.readOnly', { reason: denied })); return; }
  const latest = state.undoStacks.get(modelId)?.at(-1);
  const latestStep = latest ? state.mutationBatchTags.get(latest.id) ?? latest.id : null;
  if (step && latestStep === step) state.undo(modelId);
  else toast.error(resolve('storeyManager.copy.undoStale'));
}
