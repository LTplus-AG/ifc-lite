/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contentTransaction, contentCreatedAt, transactionDone, requestValue, type ContentRow, type MigrationRow, type RecoveryRow } from './content-database.js';
import type { ContentKind } from './content-kinds.js';

export interface ContentDefinition<T extends { id: string }> {
  kind: ContentKind;
  legacyKey: string;
  decode(value: unknown): T | null;
  /** Native legacy envelopes can hold one atomic workspace rather than a library array. */
  readLegacy?(value: unknown): { entries: unknown[]; recovered: boolean };
  /** Apply only source-reference changes from an acknowledged own import. */
  mergeCommitted?(current: T, before: unknown, committed: T): T;
}

/** Read originals without invoking legacy loaders, which can mutate damaged history. */
export function readLegacyOriginals(key: string): Array<{ key: string; raw: string }> {
  if (typeof localStorage === 'undefined') throw new Error('Legacy storage cannot be inspected');
  const values: Array<{ key: string; raw: string }> = [];
  const raw = localStorage.getItem(key);
  if (raw !== null) values.push({ key, raw });
  for (let i = 0; i < localStorage.length; i++) {
    const candidate = localStorage.key(i);
    if (candidate === `${key}:unreadable` || candidate?.startsWith(`${key}:unreadable:`)) {
      const backup = localStorage.getItem(candidate);
      if (backup !== null) values.push({ key: candidate, raw: backup });
    }
  }
  return values;
}

/** Only expose legacy neighbours after confirming that no migration marker exists. */
export class LegacyMigrationFailure<T extends { id: string }> extends Error {
  constructor(readonly entries: readonly T[], cause: unknown) {
    super('Legacy migration did not commit; originals are unchanged', { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

/** All valid neighbours, the COMPLETE original, and the marker commit together (#6679).
 * Originals stay in localStorage until an explicit verified cleanup. */
export async function migrateContent<T extends { id: string }>(definition: ContentDefinition<T>): Promise<boolean> {
  const inspect = await contentTransaction(['migrations', 'recovery'], 'readonly');
  const inspected = transactionDone(inspect);
  const previous = requestValue(inspect.objectStore('migrations').get(definition.legacyKey)) as Promise<MigrationRow | undefined>;
  const archived = requestValue(inspect.objectStore('recovery').getAllKeys());
  const [marker, keys] = await Promise.all([previous, archived, inspected]);
  if (marker) return marker.recovered || keys.some(key => typeof key === 'string' && key.startsWith(`${definition.legacyKey}:later:`));
  const originals = readLegacyOriginals(definition.legacyKey);
  const raw = originals.find(value => value.key === definition.legacyKey)?.raw ?? null;
  const entries = new Map<string, T>();
  let recovered = originals.some(value => value.key !== definition.legacyKey);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const legacy = definition.readLegacy?.(parsed);
      const values = legacy?.entries ?? parsed;
      recovered ||= legacy?.recovered ?? false;
      if (!Array.isArray(values)) throw new Error('Legacy library is not an array');
      for (const value of values) {
        const entry = definition.decode(value);
        if (!entry || entries.has(entry.id)) { recovered = true; continue; }
        entries.set(entry.id, entry);
      }
    } catch (error) {
      console.warn('[User content] Preserving unreadable legacy library', error);
      recovered = true;
    }
  }
  try {
    const tx = await contentTransaction(['items', 'migrations', 'recovery'], 'readwrite');
    const done = transactionDone(tx);
    const migrations = tx.objectStore('migrations');
    const check = migrations.get(definition.legacyKey);
    check.onsuccess = () => {
      if (check.result) { recovered = (check.result as MigrationRow).recovered; return; }
      const rows = tx.objectStore('items');
      const existing = rows.index('kind').getAll(definition.kind);
      existing.onsuccess = () => {
        const known = new Set((existing.result as ContentRow[]).map(row => row.id));
        for (const entry of entries.values()) {
          if (known.has(entry.id)) { recovered = true; continue; }
          rows.put({ kind: definition.kind, id: entry.id, version: 1, revision: 1, createdAt: contentCreatedAt(),
            modifiedAt: Date.now(), deleted: false, payload: entry } satisfies ContentRow);
        }
        for (const original of originals) tx.objectStore('recovery').put({ ...original, createdAt: Date.now() } satisfies RecoveryRow);
        migrations.put({ key: definition.legacyKey, originalKey: raw === null ? null : definition.legacyKey, recovered } satisfies MigrationRow);
      };
    };
    await done;
    return recovered;
  } catch (error) { throw new LegacyMigrationFailure([...entries.values()], error); }
}
