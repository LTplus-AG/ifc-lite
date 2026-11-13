/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addStoreyInStore, applyStoreyLevelEdit, planStoreyLevelEdit, readStoreyInventory, readTopAttachment } from '@ifc-lite/create';
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
  const match = /^(.*?)(-?\d+)(\D*)$/.exec(lower.Name.trim());
  const renames: { id: number; Name: string }[] = [];
  let Name = suggestion.Name;
  if (match && Number.isSafeInteger(Number(match[2])) && Number.isSafeInteger(Number(match[2]) + 1)) {
    const [, prefix, digits, suffix] = match;
    const next = Number(digits) + 1;
    const numbered = (n: number, width = digits.replace('-', '').length) => prefix + (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(width, '0') + suffix;
    const candidates = siblings.flatMap(level => {
      const m = /^(.*?)(-?\d+)(\D*)$/.exec(level.Name.trim());
      return level.elevation > lower.elevation && m && m[1] === prefix && m[3] === suffix && Number.isSafeInteger(Number(m[2]) + 1) && Number(m[2]) >= next
        ? [{ id: level.expressId, Name: numbered(Number(m[2]) + 1, m[2].replace('-', '').length) }] : [];
    });
    const occupied = new Set(siblings.filter(level => !candidates.some(c => c.id === level.expressId)).map(level => level.Name.toLowerCase()));
    const proposed = new Set([numbered(next), ...candidates.map(c => c.Name)].map(name => name.toLowerCase()));
    if (proposed.size === candidates.length + 1 && !occupied.has(numbered(next).toLowerCase()) && candidates.every(c => !occupied.has(c.Name.toLowerCase()))) {
      Name = numbered(next);
      renames.push(...candidates);
    }
  }
  const plan = planStoreyLevelEdit(inventory, { kind: 'floorHeight', storeyId: lowerId, Height: lower.height * 2 });
  const reboundWallIds = plan.walls.filter(wall => wall.storeyId === lowerId && readTopAttachment(inventory, wall.wallId)?.binding === 'relative').map(wall => wall.wallId);
  return { plan, renames, reboundWallIds, height: lower.height, params: { Name, Elevation: lower.elevation + lower.height, referenceStoreyId: lowerId }, version: s.mutationVersion, entry: s.session?.entry };
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
        for (const rename of reviewed.renames) draft.setAttribute(rename.id, 'Name', rename.Name);
        const added = addStoreyInStore(dataStore, draft, reviewed.params);
        storeyId = added.storeyId;
        return [...new Set([...shifted.plan.moved, ...shifted.reshaped, ...added.reshaped])];
      }), tx.batchId);
      return { created: [], deleted: [], remesh };
    },
  };
  const get = useViewerStore.getState;
  const result = runTransaction(useViewerStore, command, null, { get, modelId, storeyId: get().session?.storeyId ?? null, workplane: null });
  return result.ok ? { ...result, storeyId } : result;
}
