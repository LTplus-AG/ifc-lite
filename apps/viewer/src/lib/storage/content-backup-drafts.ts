/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentKind, RecoveryRow } from './content-database.js';
import { computeFullSourceHash } from '../../utils/sourceContentHash.js';

/** Incomplete content is recovery evidence, never a relaxed durable-library entry. */
export interface ContentDraftEvidence { kind: ContentKind; id: string; raw: string }
export const BACKUP_DRAFT_PREFIX = 'backup-draft:';
const pending = new Map<string, ContentDraftEvidence>();
const identity = (draft: ContentDraftEvidence): string => JSON.stringify(draft);

/** Validate the recovery envelope and its JSON identity, without interpreting blocks. */
export function parseContentDrafts(value: unknown): ContentDraftEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid draft recovery evidence');
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid draft recovery entry');
    const draft = raw as Record<string, unknown>;
    if (typeof draft.kind !== 'string' || !['validation', 'comparison', 'document', 'assistant'].includes(draft.kind)
      || typeof draft.id !== 'string' || !draft.id || typeof draft.raw !== 'string') {
      throw new Error('Invalid draft recovery entry');
    }
    const payload: unknown = JSON.parse(draft.raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || (payload as Record<string, unknown>).id !== draft.id) throw new Error('Draft recovery identity does not match');
    return { kind: draft.kind as ContentKind, id: draft.id, raw: draft.raw };
  });
}

export function mergeContentDrafts(...collections: readonly ContentDraftEvidence[][]): ContentDraftEvidence[] {
  return [...new Map(collections.flat().map(draft => [identity(draft), draft])).values()];
}
export function stageContentDrafts(drafts: ContentDraftEvidence[]): void {
  for (const draft of drafts) pending.set(identity(draft), structuredClone(draft));
}
export function pendingContentDrafts(): ContentDraftEvidence[] { return structuredClone([...pending.values()]); }
export function forgetContentDrafts(drafts: ContentDraftEvidence[]): void {
  for (const draft of drafts) pending.delete(identity(draft));
}

/** Hash before opening IDB; imported raw evidence is idempotent and byte-preserving. */
export async function draftRecoveryRows(drafts: ContentDraftEvidence[]): Promise<RecoveryRow[]> {
  return Promise.all(drafts.map(async draft => {
    const raw = identity(draft), hash = await computeFullSourceHash(new TextEncoder().encode(raw));
    if (!hash) throw new Error('Web Crypto is required to preserve backup draft evidence');
    return { key: `${BACKUP_DRAFT_PREFIX}${hash}`, raw, createdAt: Date.now() };
  }));
}
