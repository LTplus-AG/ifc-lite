/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preflight for a reviewed model change batch: resolve every target, check the
 * edit gate, and compare each expected value with the effective value now. The
 * preview is a pure snapshot; commit re-runs it and refuses if anything moved.
 */

import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import type { ChangeScalar, ModelChange, ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { resolveGlobalId } from './resolve-global-id';
import { currentValue, modelReader, sameValue, UNSUPPORTED_VALUE, type CurrentValue } from './model-change-values';

export type RowStatus = 'ready' | 'unchanged' | 'conflict' | 'missing-target' | 'ambiguous-target' | 'denied' | 'unsupported';

export interface PreviewRow {
  index: number;
  change: ModelChange;
  status: RowStatus;
  modelId: string | null;
  expressId: number | null;
  /** Effective value now; undefined when the target did not resolve. */
  current?: ChangeScalar;
  /** The edit-gate refusal when status is denied. */
  denial?: string;
}

export interface ModelChangePreview {
  batch: ModelChangeBatch;
  rows: PreviewRow[];
  /** Global edit counter at preview; any change since makes the preview stale. */
  mutationVersion: number;
  /** Stable identity of the batch content, pinned by approval and receipts. */
  digest: string;
}

/** FNV-1a over the canonical batch JSON (changes or authoring): identity, not security. */
export function batchDigest(batch: object): string {
  const json = JSON.stringify(batch);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `mc1-${(hash >>> 0).toString(16).padStart(8, '0')}-${json.length}`;
}

function status(change: ModelChange, current: CurrentValue): RowStatus {
  if (current === UNSUPPORTED_VALUE) return 'unsupported';
  const attribute = change.op === 'attribute.set';
  if (!sameValue(current, change.expected, attribute)) return 'conflict';
  if (change.op === 'property.delete') return 'ready';
  return sameValue(current, change.value, attribute) ? 'unchanged' : 'ready';
}

export function previewModelChanges(state: ViewerState, batch: ModelChangeBatch): ModelChangePreview {
  const readers = new Map<string, ReturnType<typeof modelReader>>();
  const rows = batch.changes.map((change, index): PreviewRow => {
    const target = resolveGlobalId(state, change.target);
    if (target === 'missing' || target === 'ambiguous') {
      return { index, change, status: target === 'missing' ? 'missing-target' : 'ambiguous-target', modelId: null, expressId: null };
    }
    if (!readers.has(target.modelId)) readers.set(target.modelId, modelReader(state, target.modelId));
    const reader = readers.get(target.modelId);
    if (!reader) return { index, change, status: 'missing-target', modelId: target.modelId, expressId: target.expressId };
    const value = currentValue(reader, target.expressId, change);
    const denial = mutationDenial(state, target.modelId);
    const current = value === UNSUPPORTED_VALUE ? undefined : value;
    if (denial) return { index, change, status: 'denied', denial, modelId: target.modelId, expressId: target.expressId, current };
    return { index, change, status: status(change, value), modelId: target.modelId, expressId: target.expressId, current };
  });
  return { batch, rows, mutationVersion: state.mutationVersion, digest: batchDigest(batch) };
}

/** Counts by status, for headers and receipts. */
export function previewCounts(rows: readonly PreviewRow[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { ready: 0, unchanged: 0, conflict: 0, 'missing-target': 0, 'ambiguous-target': 0, denied: 0, unsupported: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}
