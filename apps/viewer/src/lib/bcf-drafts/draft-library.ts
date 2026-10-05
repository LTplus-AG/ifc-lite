/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Native content library for BCF draft batches: CAS saves, backup, import and recovery like every other kind. */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library.js';
import type { ContentDefinition } from '../storage/content-migration.js';
import { decodeDraftBatch } from './draft-codec.js';
import type { DraftBatch } from './draft-types.js';

/** Never written by an older viewer; the migration finds nothing and only records its marker. */
export const BCF_DRAFTS_LEGACY_KEY = 'ifc-lite-bcf-drafts';

export const bcfDraftsContent: ContentDefinition<DraftBatch> = {
  kind: 'bcfDrafts', legacyKey: BCF_DRAFTS_LEGACY_KEY, decode: decodeDraftBatch,
};

export const useBcfDraftLibrary = create<{ entries: DraftBatch[]; status: ContentStatus; activeId: string | null; dialogOpen: boolean }>(() => ({
  entries: [], status: initialContentStatus(), activeId: null, dialogOpen: false,
}));

export const bcfDraftLibrary = createContentLibrary(bcfDraftsContent,
  () => useBcfDraftLibrary.getState().entries,
  (entries, status) => useBcfDraftLibrary.setState(state => ({ entries, status,
    activeId: state.activeId && entries.some(entry => entry.id === state.activeId) ? state.activeId : entries[0]?.id ?? null })));

/** Save one batch; a refusal keeps the edit visible as a staged draft with its native save state. */
export function saveDraftBatch(batch: DraftBatch): Promise<boolean> {
  return bcfDraftLibrary.put(batch.id, batch);
}

/**
 * Archive imports never overwrite a local batch: a batch whose id already
 * exists with different content is kept as an independent copy. Topic GUIDs
 * stay, so publication mappings of the original still recognise them.
 */
export async function adoptImportedBatches(batches: readonly DraftBatch[]): Promise<DraftBatch[]> {
  const existing = useBcfDraftLibrary.getState().entries;
  const adopted: DraftBatch[] = [];
  for (const batch of batches) {
    const current = existing.find(entry => entry.id === batch.id);
    if (current && JSON.stringify(current.topics) === JSON.stringify(batch.topics)) { adopted.push(current); continue; }
    const next = current ? { ...batch, id: crypto.randomUUID(), name: `${batch.name} (imported)`.slice(0, 200) } : batch;
    await saveDraftBatch(next);
    adopted.push(next);
  }
  return adopted;
}
