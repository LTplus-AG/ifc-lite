/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addStoreyInStore, applyStoreyLevelEdit, planStoreyLevelEdit, readStoreyInventory } from '@ifc-lite/create';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { modelEditTarget, recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { ModelingCommand } from '@/lib/commands/modeling/types';
import { storeyRows, storeySuggestion } from '@/lib/storeys/storey-actions';

/** #9296: make a whole floor of room, then insert into it; never halve a floor. */
export function reviewStoreyInsertion(modelId: string, referenceId: number, fallbackName: (index: number) => string, side: 'above' | 'below' = 'above') {
  const s = useViewerStore.getState();
  const target = modelEditTarget(s, modelId);
  if (!target) return null;
  const inventory = readStoreyInventory(target.dataStore, target.view);
  const home = inventory.storeys.find(storey => storey.expressId === referenceId);
  const siblings = !home ? [] : home.parentId === null ? [home] : inventory.storeys.filter(storey => storey.parentId === home.parentId);
  const lowerRef = side === 'above' ? referenceId : siblings[siblings.findIndex(storey => storey.expressId === referenceId) - 1]?.expressId;
  const lower = storeyRows(s, modelId).find(row => row.expressId === lowerRef);
  if (!lower?.height) return null;
  const lowerId = lower.expressId;
  const suggestion = storeySuggestion(s, modelId, lowerId, 'above', fallbackName);
  if (!suggestion) return null;
  const plan = planStoreyLevelEdit(inventory, { kind: 'floorHeight', storeyId: lowerId, Height: lower.height * 2 });
  return { plan, height: lower.height, params: { Name: suggestion.Name, Elevation: lower.elevation + lower.height, referenceStoreyId: lowerId }, version: s.mutationVersion, entry: s.session?.entry };
}

export type StoreyInsertion = NonNullable<ReturnType<typeof reviewStoreyInsertion>>;

export function commitStoreyInsertion(modelId: string, reviewed: StoreyInsertion): { ok: true; storeyId: number | null; batchId: string | null } | { ok: false; reason: string } {
  if (reviewed.entry !== useViewerStore.getState().session?.entry || reviewed.version !== useViewerStore.getState().mutationVersion) return { ok: false as const, reason: resolve('storeyManager.refusal.stale') };
  let storeyId: number | null = null;
  const command: ModelingCommand = {
    id: 'storey.insert', labelKey: 'storeyManager.undoLabel', hud: {}, snap: 'modeling', init: () => null, pointerMove: g => g, pointerDown: g => g,
    commit: (_g, tx) => {
      const remesh = recordModellingCommit(tx.api, modelId, (editor, dataStore) => editor.runAtomic(draft => {
        const shifted = applyStoreyLevelEdit(dataStore, draft, reviewed.plan.edit, reviewed.plan);
        const added = addStoreyInStore(dataStore, draft, reviewed.params);
        storeyId = added.storeyId;
        return [...new Set([...shifted.plan.moved, ...shifted.reshaped, ...added.reshaped])];
      }), tx.batchId);
      return { created: [], remesh };
    },
  };
  const get = useViewerStore.getState;
  const result = runTransaction(useViewerStore, command, null, { get, modelId, storeyId: get().session?.storeyId ?? null, workplane: null });
  return result.ok ? { ...result, storeyId } : result;
}
