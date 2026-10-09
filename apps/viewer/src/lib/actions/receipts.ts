import { STRUCTURAL_OPS } from './structural-graph-proposal';
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Durable receipts of reviewed model changes, stored as a native content kind
 * so they survive reload, travel in backups and recover like other libraries.
 * Undo history itself is session state: after reload a receipt still records
 * what was applied, but its undo reports that the batch left the history.
 */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library';
import type { ContentDefinition } from '../storage/content-migration';
import type { AppliedChange, ModelChangeReceipt } from './model-change-commit';
import { AUTHORING_OPS } from './model-authoring';
import { VERDICT_SPEC_LIMIT, type ReceiptValidation } from './validation-verdicts';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const OPS = new Set<string>(['property.set', 'property.delete', 'quantity.set', 'attribute.set', 'room.command', ...STRUCTURAL_OPS, ...AUTHORING_OPS]);

function applied(value: unknown): value is AppliedChange {
  return record(value) && Number.isInteger(value.index) && OPS.has(String(value.op)) && typeof value.globalId === 'string'
    && typeof value.modelId === 'string' && typeof value.field === 'string' && scalar(value.before) && scalar(value.after)
    && (!STRUCTURAL_OPS.includes(value.op as typeof STRUCTURAL_OPS[number]) || Number.isSafeInteger(value.expressId) && (value.expressId as number) > 0);
}

const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
function verdicts(value: unknown): boolean {
  return Array.isArray(value) && value.length <= VERDICT_SPEC_LIMIT && value.every((item) => record(item)
    && typeof item.id === 'string' && typeof item.name === 'string' && count(item.passed) && count(item.failed));
}

/** Optional since P15; receipts written before it have no validation block. */
function validation(value: unknown): value is ReceiptValidation {
  return record(value) && (value.source === 'ids' || value.source === 'rules') && typeof value.title === 'string'
    && ['current', 'stale', 'unknown'].includes(String(value.beforeFreshness)) && verdicts(value.before)
    && (value.after === undefined || verdicts(value.after)) && (value.rerunAt === undefined || typeof value.rerunAt === 'string');
}

export function decodeModelChangeReceipt(value: unknown): ModelChangeReceipt | null {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string'
    || typeof value.digest !== 'string' || typeof value.createdAt !== 'string' || typeof value.origin !== 'string'
    || (value.status !== 'applied' && value.status !== 'undone')
    || !Array.isArray(value.batches) || !Array.isArray(value.applied) || !Array.isArray(value.skipped)
    || value.applied.length > 1000 || value.skipped.length > 1000) return null;
  if (!value.batches.every((batch) => record(batch) && typeof batch.modelId === 'string' && typeof batch.batchId === 'string')) return null;
  if (!value.applied.every(applied)) return null;
  if (!value.skipped.every((skip) => record(skip) && Number.isInteger(skip.index) && typeof skip.status === 'string')) return null;
  if (value.undoneAt !== undefined && typeof value.undoneAt !== 'string') return null;
  if (value.kind !== undefined && value.kind !== 'model.authoring' && value.kind !== 'room.command' && value.kind !== 'structural.graph') return null;
  if (value.applied.some(item => record(item) && STRUCTURAL_OPS.includes(item.op as typeof STRUCTURAL_OPS[number])) && value.kind !== 'structural.graph') return null;
  if (value.validation !== undefined && !validation(value.validation)) return null;
  return structuredClone(value) as unknown as ModelChangeReceipt;
}

export const modelChangeContent: ContentDefinition<ModelChangeReceipt> = {
  kind: 'modelChanges', legacyKey: 'ifc-lite-model-change-receipts-v1', decode: decodeModelChangeReceipt,
};

export const useModelChangeReceipts = create<{ entries: ModelChangeReceipt[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const modelChangeLibrary = createContentLibrary(modelChangeContent,
  () => useModelChangeReceipts.getState().entries,
  (entries, status) => useModelChangeReceipts.setState({ entries, status }));
