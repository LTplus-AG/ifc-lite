/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the storey chip, picker and manager do (#9013), above the one write
 * path (`commitStoreyOp`): smart defaults for a new storey, keeping the
 * session on a live storey, and making a new storey the one being drawn on.
 */

import {
  planStoreyDelete, readStoreyInventory, storeyDeletePlanSignature, suggestStorey, summarizeStoreys,
  type StoreyDeleteMode, type StoreyDeletePlan, type StoreySuggestion, type StoreySummary,
} from '@ifc-lite/create';
import type { TransactionStore } from '@/lib/commands/modeling/transaction';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commitStoreyOp, storeyOpRefusals, type StoreyOpOutcome } from '@/store/slices/mutation-storey';
import { activateStorey, switchSessionStorey } from './storey-session';

export { openStoreyManager } from './storey-manager-open';
export { activateStorey } from './storey-session';

/**
 * The rows a storey manager lists, highest first. Throws when the model has
 * no editable data: that is a failed read, not a model without storeys.
 */
export function storeyRows(s: ViewerState, modelId: string): StoreySummary[] {
  const target = modelEditTarget(s, modelId);
  if (!target) throw new Error(`No model loaded for id "${modelId}"`);
  return summarizeStoreys(readStoreyInventory(target.dataStore, target.view));
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

/**
 * What deleting a storey with its contents would remove, as the delete panel
 * shows it; passed back to `deleteStorey` so contents added after the panel
 * opened are refused (`stale`) rather than deleted unseen.
 */
export function reviewStoreyDeletion(s: ViewerState, modelId: string, storeyId: number): StoreyDeletePlan | null {
  const target = modelEditTarget(s, modelId);
  return target ? planStoreyDelete(readStoreyInventory(target.dataStore, target.view), storeyId, { kind: 'deleteContents' }) : null;
}

/**
 * Delete a storey. When it is the one being drawn on, the session moves to
 * the storey below it (or above, for the lowest) first, so it never points
 * at a deleted storey; if the deletion is then refused, the session moves back.
 *
 * `reviewed` is the plan the delete panel showed (`reviewStoreyDeletion`).
 * Deleting the contents passes it to the write, which refuses a model that
 * changed since; moving them checks it here, since a move is a different
 * plan: contents that changed since the panel opened are refused as stale.
 */
export function deleteStorey(
  store: TransactionStore, modelId: string, storeyId: number, mode: StoreyDeleteMode, reviewed?: StoreyDeletePlan,
): StoreyOpOutcome {
  const s = store.getState();
  if (reviewed && mode.kind !== reviewed.mode.kind) {
    const now = reviewStoreyDeletion(s, modelId, storeyId);
    if (!now || storeyDeletePlanSignature(now) !== storeyDeletePlanSignature(reviewed)) {
      const stale = { code: 'stale', message: 'The storey changed since the deletion was reviewed; review it again' } as const;
      return { ok: false, reason: stale.message, refusals: [stale] };
    }
  }
  const op = { kind: 'delete', storeyId, mode, expected: reviewed && mode.kind === reviewed.mode.kind ? reviewed : undefined } as const;
  const refusals = storeyOpRefusals(s, modelId, op);
  if (refusals.length) return { ok: false, reason: refusals.map((r) => r.message).join('; '), refusals };
  const previous = s.session?.modelId === modelId ? s.session.storeyId : null;
  if (previous === storeyId) {
    const rows = storeyRows(s, modelId);
    const index = rows.findIndex((row) => row.expressId === storeyId);
    const next = rows[index + 1] ?? rows[index - 1];
    if (next) switchSessionStorey(s, next.expressId);
  }
  const outcome = commitStoreyOp(store, modelId, op);
  // A refused write leaves the storey in place: so is the session.
  if (!outcome.ok && previous === storeyId) switchSessionStorey(store.getState(), storeyId);
  return outcome;
}
