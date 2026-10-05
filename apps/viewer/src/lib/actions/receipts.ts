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

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const OPS = new Set<string>(['property.set', 'property.delete', 'quantity.set', 'attribute.set', ...AUTHORING_OPS]);

function applied(value: unknown): value is AppliedChange {
  return record(value) && Number.isInteger(value.index) && OPS.has(String(value.op)) && typeof value.globalId === 'string'
    && typeof value.modelId === 'string' && typeof value.field === 'string' && scalar(value.before) && scalar(value.after);
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
  if (value.kind !== undefined && value.kind !== 'model.authoring') return null;
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
