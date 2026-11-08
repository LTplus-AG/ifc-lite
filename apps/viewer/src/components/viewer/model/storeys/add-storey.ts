/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { storeySuggestion } from '@/lib/storeys/storey-actions';
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { activateStorey } from '@/lib/storeys/storey-session';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';

/** #9334: a persistent add toast must recheck its target when clicked. */
export function drawOnAddedStorey(modelId: string, storeyId: number): void {
  const state = useViewerStore.getState();
  if (!state.session || !modelStoreys(state, modelId).some(storey => storey.expressId === storeyId)) return;
  if ('refused' in resolveWorkplane(state, modelId, { kind: 'storey', storeyId, offset: 0 })) return;
  activateStorey(state, modelId, storeyId);
}

/** #9296: adding a level never changes the plane of the next drawing gesture. */
export function addStoreyKeepingSession(modelId: string, referenceId: number, side: 'above' | 'below', fallbackName: (index: number) => string) {
  const suggestion = storeySuggestion(useViewerStore.getState(), modelId, referenceId, side, fallbackName);
  if (!suggestion) return { ok: false as const, reason: `No model loaded for id "${modelId}"`, refusals: [] };
  return commitStoreyOp(useViewerStore, modelId, {
    kind: 'add', params: { Name: suggestion.Name, Elevation: suggestion.Elevation, referenceStoreyId: referenceId },
  });
}
