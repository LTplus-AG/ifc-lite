/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Outbox persistence. The visible library uses the shared content controller
 * (backup, import, recovery, notice); dispatch writes go through
 * `mutatePublication`, a read-modify-write on the committed row with CAS, so
 * an intent is durable before its request leaves and two tabs can never both
 * claim the same queued entry.
 */

import { create } from 'zustand';
import { readContentRows, writeContent } from '../storage/content-database.js';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library.js';
import type { ContentDefinition } from '../storage/content-migration.js';
import { decodePublication } from './outbox-codec.js';
import { recoverInterrupted } from './outbox-state.js';
import type { BcfPublication } from './outbox-types.js';

export const BCF_OUTBOX_LEGACY_KEY = 'ifc-lite-bcf-outbox';
export const bcfOutboxContent: ContentDefinition<BcfPublication> = {
  kind: 'bcfOutbox', legacyKey: BCF_OUTBOX_LEGACY_KEY, decode: decodePublication,
};

export const useBcfOutbox = create<{ entries: BcfPublication[]; status: ContentStatus }>(() => ({
  entries: [], status: initialContentStatus(),
}));
export const bcfOutboxLibrary = createContentLibrary(bcfOutboxContent,
  () => useBcfOutbox.getState().entries,
  (entries, status) => useBcfOutbox.setState({ entries, status }));

/** Entries this tab is sending right now; recovery must not mark them interrupted. */
export const inFlightEntries = new Set<string>();

export async function readPublication(id: string): Promise<{ record: BcfPublication; revision: number } | undefined> {
  const row = (await readContentRows('bcfOutbox')).find(item => item.id === id && !item.deleted);
  const record = row ? decodePublication(row.payload) : null;
  return row && record ? { record, revision: row.revision } : undefined;
}

export async function readPublications(): Promise<BcfPublication[]> {
  return (await readContentRows('bcfOutbox')).flatMap(row => {
    const record = row.deleted ? null : decodePublication(row.payload);
    return record ? [record] : [];
  });
}

/**
 * Apply `change` to the committed record and write it with compare-and-swap,
 * re-reading on a concurrent write. `change` returns null to leave the row
 * unchanged. Resolves to the committed record, or null when storage refused
 * (the caller must then not dispatch).
 */
export async function mutatePublication(id: string,
  change: (current: BcfPublication | undefined) => BcfPublication | null): Promise<BcfPublication | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let current: Awaited<ReturnType<typeof readPublication>>;
    let revision = 0;
    try {
      const rows = await readContentRows('bcfOutbox');
      const row = rows.find(item => item.id === id);
      revision = row?.revision ?? 0;
      const record = row && !row.deleted ? decodePublication(row.payload) : null;
      current = record ? { record, revision } : undefined;
    } catch (error) {
      console.warn('[BCF outbox] Could not read the publication record', error);
      return null;
    }
    const next = change(current?.record);
    if (!next) return current?.record ?? null;
    const result = await writeContent('bcfOutbox', id, next, revision);
    if (result.ok) {
      void bcfOutboxLibrary.refresh().catch(error => console.warn('[BCF outbox] Visible queue refresh failed', error));
      return next;
    }
    if (result.reason !== 'conflict') return null;
  }
  return null;
}

/** On startup, writes left `sending` by a closed page become `uncertain` (never resent). */
export async function recoverInterruptedPublications(now = () => new Date().toISOString()): Promise<number> {
  let recovered = 0;
  for (const record of await readPublications()) {
    const updated = await mutatePublication(record.id, current =>
      current ? recoverInterrupted(current, inFlightEntries, now()) : null);
    if (updated && updated !== record) recovered += updated.entries.filter((entry, index) =>
      entry.state === 'uncertain' && record.entries[index]?.state === 'sending').length;
  }
  return recovered;
}

/** Native host initialisation: recover interrupted writes first, then hydrate the visible queue. */
export async function initializeBcfOutbox(): Promise<boolean> {
  try { await recoverInterruptedPublications(); }
  catch (error) { console.warn('[BCF outbox] Interrupted-write recovery could not run; queue stays as stored', error); }
  return bcfOutboxLibrary.initialize();
}
