/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the storey chip, picker and manager do (#9013), above the one write
 * path (`commitStoreyOp`): smart defaults for a new storey, keeping the
 * session on a live storey, and making a new storey the one being drawn on.
 */

import {
  readStoreyInventory, suggestStorey, summarizeStoreys,
  type StoreyDeleteMode, type StoreySuggestion, type StoreySummary,
} from '@ifc-lite/create';
import type { TransactionStore } from '@/lib/commands/modeling/transaction';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commitStoreyOp, storeyOpRefusals, type StoreyOpOutcome } from '@/store/slices/mutation-storey';

/** Show the storey manager in the Model inspector. */
export function openStoreyManager(s: Pick<ViewerState, 'setStoreyManagerOpen' | 'showWorkspacePanel' | 'sidebarActivePanel'>): void {
  s.setStoreyManagerOpen(true);
  if (s.sidebarActivePanel !== 'model') s.showWorkspacePanel('model');
}

/** The rows a storey manager lists, highest first; empty when the model has no editable data. */
export function storeyRows(s: ViewerState, modelId: string): StoreySummary[] {
  const target = modelEditTarget(s, modelId);
  return target ? summarizeStoreys(readStoreyInventory(target.dataStore, target.view)) : [];
}

/** The default storey next to `referenceId`; null when the model cannot be read. */
export function storeySuggestion(
  s: ViewerState, modelId: string, referenceId: number, side: 'above' | 'below', fallbackName: (index: number) => string,
): StoreySuggestion | null {
  const target = modelEditTarget(s, modelId);
  return target ? suggestStorey(readStoreyInventory(target.dataStore, target.view), referenceId, side, fallbackName) : null;
}

/**
 * Add a storey above or below `referenceId` with the neighbourhood's own
 * name pattern and spacing, and draw on it straight away.
 */
export function addStoreyNextTo(
  store: TransactionStore, modelId: string, referenceId: number, side: 'above' | 'below',
  fallbackName: (index: number) => string,
): StoreyOpOutcome {
  const suggestion = storeySuggestion(store.getState(), modelId, referenceId, side, fallbackName);
  if (!suggestion) return { ok: false, reason: `No model loaded for id "${modelId}"`, refusals: [] };
  const outcome = commitStoreyOp(store, modelId, {
    kind: 'add', params: { Name: suggestion.Name, Elevation: suggestion.Elevation, referenceStoreyId: referenceId },
  });
  if (outcome.ok && outcome.storeyId !== null) activateStorey(store.getState(), modelId, outcome.storeyId);
  return outcome;
}

/** Make `storeyId` the storey the session draws on (workplane, plan and tools follow). */
export function activateStorey(s: ViewerState, modelId: string, storeyId: number): void {
  const session = s.session;
  if (session?.modelId === modelId) {
    if (session.storeyId !== storeyId) s.setSessionStorey(storeyId);
    return;
  }
  if (s.workspaceMode === 'model' && session) {
    const command = session.activeCommandId ?? undefined;
    s.exitModelWorkspace();
    s.enterModelWorkspace({ modelId, storeyId, command });
  }
}

/**
 * Delete a storey. When it is the one being drawn on, the session moves to
 * the storey below it (or above, for the lowest) first, so it never points
 * at a deleted storey.
 */
export function deleteStorey(store: TransactionStore, modelId: string, storeyId: number, mode: StoreyDeleteMode): StoreyOpOutcome {
  const s = store.getState();
  const op = { kind: 'delete', storeyId, mode } as const;
  const refusals = storeyOpRefusals(s, modelId, op);
  if (refusals.length) return { ok: false, reason: refusals.map((r) => r.message).join('; '), refusals };
  if (s.session?.modelId === modelId && s.session.storeyId === storeyId) {
    const rows = storeyRows(s, modelId);
    const index = rows.findIndex((row) => row.expressId === storeyId);
    const next = rows[index + 1] ?? rows[index - 1];
    if (next) s.setSessionStorey(next.expressId);
  }
  return commitStoreyOp(store, modelId, op);
}
