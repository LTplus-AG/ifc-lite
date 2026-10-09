/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Commit of an approved, previewed model change batch: one native undo batch
 * per model through `runTransaction`, so Ctrl+Z, the Changes panel and change
 * sets all see exactly what was applied. A receipt pins the batch digest and
 * the before/after values; undo goes through `revertChangeOperation`, which
 * refuses when newer edits touched the same values.
 */

import type { StoreApi } from 'zustand';
import { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '@/store';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { ModelingCommand } from '@/lib/commands/modeling/types';
import { changeOperations } from '@/lib/changes/change-operations';
import { revertChangeOperation, type RevertRefusal } from '@/lib/changes/revert-change-operation';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ChangeScalar, ModelChange } from '@ifc-lite/ai/artifacts';
import type { AuthoringOpName } from './model-authoring';
import type { CostOpName } from './cost-graph-proposal';
import { previewModelChanges, type ModelChangePreview, type PreviewRow } from './model-change-preview';
import type { ReceiptValidation } from './validation-verdicts';

export interface AppliedChange {
  index: number;
  op: ModelChange['op'] | AuthoringOpName | CostOpName | 'room.command';
  /** Empty only for non-root Cost records, which are addressed by native expressId. */
  globalId: string;
  expressId?: number;
  modelId: string;
  /** Human-readable address of the value, e.g. `Pset_WallCommon.FireRating`. */
  field: string;
  before: ChangeScalar;
  after: ChangeScalar;
}

export interface ModelChangeReceipt {
  version: 1;
  /** Absent on model.changes; other native reviewed producer kinds share the same durable receipt/Undo route. */
  kind?: 'model.authoring' | 'room.command' | 'cost.graph';
  id: string;
  title: string;
  digest: string;
  createdAt: string;
  /** Where the batch came from, e.g. an assistant conversation id. */
  origin: string;
  batches: Array<{ modelId: string; batchId: string }>;
  applied: AppliedChange[];
  skipped: Array<{ index: number; status: PreviewRow['status'] | 'invalid' | 'blocked' | 'not-approved' }>;
  status: 'applied' | 'undone';
  undoneAt?: string;
  /** Validation verdict counts before the apply and, once re-run, after it (P15). */
  validation?: ReceiptValidation;
}

export type CommitOutcome =
  | { ok: true; receipt: ModelChangeReceipt }
  | { ok: false; reason: 'stale' | 'nothing-approved' | 'refused'; detail?: string };

export function changeField(change: ModelChange): string {
  switch (change.op) {
    case 'property.set': case 'property.delete': return `${change.pset}.${change.name}`;
    case 'quantity.set': return `${change.qset}.${change.name}`;
    case 'attribute.set': return change.name;
  }
}

function propertyType(value: Exclude<ChangeScalar, null>): PropertyValueType {
  if (typeof value === 'boolean') return PropertyValueType.Boolean;
  if (typeof value === 'number') return Number.isInteger(value) ? PropertyValueType.Integer : PropertyValueType.Real;
  return PropertyValueType.Label;
}

/** Write one change through the store's gated actions; throws so the transaction rolls back. */
function write(state: ViewerState, modelId: string, expressId: number, change: ModelChange, before: ChangeScalar): void {
  const target = modelEditTarget(state, modelId);
  if (!target) throw new Error(`Model ${modelId} is not loaded`);
  let written: unknown;
  switch (change.op) {
    case 'property.set':
      written = state.setProperty(modelId, expressId, change.pset, change.name, change.value, propertyType(change.value), change.dataType);
      break;
    case 'property.delete':
      written = state.deleteProperty(modelId, expressId, change.pset, change.name);
      break;
    case 'quantity.set': {
      const quantity = target.view.getQuantitiesForEntity(expressId).find((set) => set.name === change.qset)
        ?.quantities.find((candidate) => candidate.name === change.name);
      if (!quantity) throw new Error(`${change.qset}.${change.name} no longer exists`);
      written = state.setQuantity(modelId, expressId, change.qset, change.name, change.value, quantity.type, quantity.unit);
      break;
    }
    case 'attribute.set':
      written = state.setAttribute(modelId, expressId, change.name, change.value, typeof before === 'string' ? before : '');
      break;
  }
  if (!written) throw new Error(`The model refused ${changeField(change)} on ${change.target.globalId}`);
}

export function commitModelChanges(
  store: StoreApi<ViewerState>,
  preview: ModelChangePreview,
  approved: ReadonlySet<number>,
  origin: string,
): CommitOutcome {
  // Re-run the preflight: approval covers what was shown, nothing that moved since.
  const fresh = previewModelChanges(store.getState(), preview.batch);
  if (fresh.digest !== preview.digest || store.getState().mutationVersion !== preview.mutationVersion) return { ok: false, reason: 'stale' };
  const chosen = fresh.rows.filter((row) => approved.has(row.index) && row.status === 'ready');
  if (chosen.length === 0) return { ok: false, reason: 'nothing-approved' };
  const byModel = new Map<string, PreviewRow[]>();
  for (const row of chosen) byModel.set(row.modelId!, [...(byModel.get(row.modelId!) ?? []), row]);

  const batches: ModelChangeReceipt['batches'] = [];
  for (const [modelId, rows] of byModel) {
    const command: ModelingCommand = {
      id: 'assistant.modelChanges', labelKey: 'modelChanges.commandLabel', hud: {}, snap: 'modeling',
      init: () => null, pointerMove: (g) => g, pointerDown: (g) => g,
      commit: (_g, tx) => {
        for (const row of rows) write(tx.store, modelId, row.expressId!, row.change, row.current ?? null);
        return { created: [], deleted: [], remesh: [] };
      },
    };
    const get = store.getState;
    const outcome = runTransaction(store, command, null, { get, modelId, storeyId: null, workplane: null });
    if (!outcome.ok || !outcome.batchId) {
      // Keep a multi-model batch all-or-nothing: revert models already committed.
      for (const done of [...batches].reverse()) undoBatch(store, done.batchId);
      return { ok: false, reason: 'refused', detail: outcome.ok ? 'No values changed' : outcome.reason };
    }
    batches.push({ modelId, batchId: outcome.batchId });
  }

  const applied = chosen.map((row): AppliedChange => ({
    index: row.index, op: row.change.op, globalId: row.change.target.globalId, modelId: row.modelId!,
    field: changeField(row.change), before: row.current ?? null,
    after: row.change.op === 'property.delete' ? null : row.change.value,
  }));
  const skipped = fresh.rows.filter((row) => !chosen.includes(row))
    .map((row) => ({ index: row.index, status: row.status === 'ready' ? 'not-approved' as const : row.status }));
  return { ok: true, receipt: { version: 1, id: crypto.randomUUID(), title: preview.batch.title, digest: preview.digest,
    createdAt: new Date().toISOString(), origin, batches, applied, skipped, status: 'applied' } };
}

export type UndoOutcome = { ok: true } | { ok: false; reason: RevertRefusal | 'not-in-history' | 'already-undone' };

/** Revert one native batch through the Changes panel's revert (refuses when newer edits touched the same values). */
export function undoBatch(store: StoreApi<ViewerState>, batchId: string): UndoOutcome {
  const state = store.getState();
  const operation = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(store))
    .find((candidate) => candidate.id === `batch:${batchId}`);
  if (!operation) return { ok: false, reason: 'not-in-history' };
  const result = revertChangeOperation(store, operation);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * Undo every native batch of a receipt, newest first. A refusal (newer edits to
 * the same values, a shared session, history cleared by reload) stops and is
 * reported; batches already reverted stay reverted, and the caller records that.
 */
export function undoModelChanges(store: StoreApi<ViewerState>, receipt: ModelChangeReceipt): UndoOutcome {
  if (receipt.status === 'undone') return { ok: false, reason: 'already-undone' };
  for (const batch of [...receipt.batches].reverse()) {
    const outcome = undoBatch(store, batch.batchId);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}
