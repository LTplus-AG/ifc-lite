/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The common result of turning an existing editing workflow (a CSV table, a
 * bulk action, an IDS correction) into reviewed `model.changes` batches (P15).
 * Converters only read; every row that cannot become a checked change is
 * reported as an issue instead of being guessed.
 *
 * Batch size: one batch holds at most MODEL_CHANGE_LIMIT changes, so a larger
 * set is split into numbered parts, each reviewed and applied (and undone) on
 * its own. Parts never share a value, so applying one cannot make another
 * conflict. Above MODEL_CHANGE_PART_LIMIT parts the set is refused with
 * guidance to narrow it, rather than producing an unreviewable stack.
 */

import { changeKey, MODEL_CHANGE_LIMIT, type ModelChange, type ModelChangeBatch } from './model-change';

export const MODEL_CHANGE_PART_LIMIT = 20;
/** Largest change set a converter turns into reviewed parts. */
export const MODEL_CHANGE_SET_LIMIT = MODEL_CHANGE_LIMIT * MODEL_CHANGE_PART_LIMIT;

export type ConversionIssueKind =
  | 'missing-key' | 'unmatched-key' | 'ambiguous-key' | 'duplicate-key' | 'invalid-value' | 'missing-quantity'
  | 'unit-mismatch' | 'unsupported-value' | 'no-global-id' | 'unsupported-action' | 'model-unavailable';

export interface ConversionIssue {
  kind: ConversionIssueKind;
  /** 1-based data row of a table, when the issue comes from one. */
  row?: number;
  column?: string;
  /** Element label (name or GlobalId) when known. */
  element?: string;
  detail?: string;
}

export interface ChangeConversion {
  title: string;
  batches: ModelChangeBatch[];
  issues: ConversionIssue[];
  /** Values that already equal the requested value; nothing to change. */
  unchanged: number;
  /** Changes produced before any splitting or refusal. */
  total: number;
  /** True when the set exceeded MODEL_CHANGE_SET_LIMIT and was not split. */
  refused: boolean;
  /** Why no row could be converted at all. */
  refusal?: 'model-unavailable' | 'tag-scan-limit';
}

const TITLE_MAX = 160;

/** Split checked changes into numbered review parts, or refuse an oversized set. */
export function toConversion(title: string, rationale: string | undefined, changes: ModelChange[],
  issues: ConversionIssue[], unchanged: number): ChangeConversion {
  const short = title.trim().slice(0, TITLE_MAX) || 'Model changes';
  const seen = new Set<string>();
  for (const change of changes) {
    const key = changeKey(change);
    if (seen.has(key)) throw new Error(`Converter produced two changes for ${key}`);
    seen.add(key);
  }
  if (changes.length > MODEL_CHANGE_SET_LIMIT) {
    return { title: short, batches: [], issues, unchanged, total: changes.length, refused: true };
  }
  const parts = Math.ceil(changes.length / MODEL_CHANGE_LIMIT);
  const batches: ModelChangeBatch[] = [];
  for (let part = 0; part < parts; part++) {
    batches.push({ version: 1, kind: 'model.changes', title: parts > 1 ? `${short} (part ${part + 1} of ${parts})` : short,
      ...(rationale ? { rationale: rationale.slice(0, 2000) } : {}),
      changes: changes.slice(part * MODEL_CHANGE_LIMIT, (part + 1) * MODEL_CHANGE_LIMIT) });
  }
  return { title: short, batches, issues, unchanged, total: changes.length, refused: false };
}
