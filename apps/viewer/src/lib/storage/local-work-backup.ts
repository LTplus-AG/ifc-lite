/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SCHEMA_VERSION, SETTINGS_KEY, decodeStoredSettings } from '../clash/persistence-codecs.js';
import { LEGACY_ANSWERS_KEY, LEGACY_CHECKLIST_KEY, MANUAL_LIBRARY_KEY, encodeManualLibrary, readLegacyManualLibrary } from '../validation/manual/persistence.js';
import { BASELINE_KEY, notifyBaselineChange } from '../clash/revision-baseline.js';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { isLocalWorkKey, isLocalWorkOriginalKey, localWorkCodec, LOCAL_WORK_KEYS, type LocalWorkKey } from './local-work-codecs.js';
import type { ContentDraftEvidence } from './content-backup-drafts.js';
import { optionalLocalStorage, type UnreadableEntryStorage } from './unreadable-entry.js';

export type LocalWorkBackup = Partial<Record<LocalWorkKey, string>>;

export function localWorkOriginal(id: string, raw: string): ContentDraftEvidence {
  return { kind: 'localWork', id, raw: JSON.stringify({ id, original: raw }) };
}

function readLegacyManual(storage: UnreadableEntryStorage, onFailure: (key: string, error: unknown) => void): string | null {
  const legacy = readLegacyManualLibrary(storage, onFailure, true);
  const encoded = encodeManualLibrary(legacy);
  if (encoded === null) {
    onFailure(LEGACY_ANSWERS_KEY, new Error('Too many legacy manual validation answers'));
    onFailure(LEGACY_CHECKLIST_KEY, new Error('Manual checklist could not be migrated with its answers'));
  }
  return encoded;
}

export function readLocalWorkBackup(): { localWork: LocalWorkBackup; drafts: ContentDraftEvidence[]; complete: boolean } {
  const localWork: LocalWorkBackup = {}, drafts: ContentDraftEvidence[] = [];
  const storage = optionalLocalStorage();
  if (!storage) return { localWork, drafts, complete: false };
  try {
    for (const key of LOCAL_WORK_KEYS) {
      const raw = storage.getItem(key);
      try {
        const source = raw ?? (key === MANUAL_LIBRARY_KEY ? readLegacyManual(storage, (id, error) => {
          console.warn(`[Library] Could not read ${id}; including its original in the backup`, error);
          const stored = storage.getItem(id);
          if (stored !== null) drafts.push(localWorkOriginal(id, stored));
        }) : null);
        const canonical = source === null ? null : localWorkCodec(key).canonical(source);
        if (canonical !== null) localWork[key] = canonical;
      } catch (error) {
        console.warn(`[Library] Could not decode ${key}; including its original in the backup`, error);
        if (raw !== null) drafts.push(localWorkOriginal(key, raw));
        else throw error;
      }
    }
    if (storage.key) {
      for (let index = 0; index < (storage.length ?? 0); index++) {
        const key = storage.key(index);
        // Enumerate names for quarantined copies. The allowlist gates every read.
        if (!key?.includes(':unreadable') || !isLocalWorkOriginalKey(key)) continue;
        const raw = storage.getItem(key);
        if (raw !== null) drafts.push(localWorkOriginal(key, raw));
      }
    }
    return { localWork, drafts, complete: true };
  } catch (error) {
    console.warn('[Library] Browser storage could not be fully read during backup', error);
    return { localWork, drafts, complete: false };
  }
}

export function decodeLocalWorkBackup(value: unknown): LocalWorkBackup {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local work backup');
  const entries: LocalWorkBackup = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isLocalWorkKey(key) || typeof raw !== 'string') throw new Error('Invalid local work backup entry');
    const canonical = localWorkCodec(key).canonical(raw);
    if (canonical !== null) entries[key] = canonical;
  }
  return entries;
}

/** Prepare all decisions before committing IndexedDB. Writing each native
 * record rechecks its source, since localStorage cannot share that transaction. */
export function planLocalWorkImport(incoming: LocalWorkBackup, canWrite?: (key: LocalWorkKey) => boolean) {
  const storage = optionalLocalStorage();
  const drafts: ContentDraftEvidence[] = [], pending: LocalWorkBackup = {};
  const writes: { key: LocalWorkKey; previous: string | null; raw: string; source: string; legacy?: (string | null)[] }[] = [];
  for (const key of LOCAL_WORK_KEYS) {
    const source = incoming[key];
    if (source === undefined) continue;
    try {
      if (canWrite && !canWrite(key)) { pending[key] = source; continue; }
      if (!storage) throw new Error('Browser storage is unavailable');
      const previous = storage.getItem(key), codec = localWorkCodec(key);
      const legacy = key === MANUAL_LIBRARY_KEY && previous === null
        ? [storage.getItem(LEGACY_ANSWERS_KEY), storage.getItem(LEGACY_CHECKLIST_KEY)] : undefined;
      let current: string | null;
      try {
        const stored = previous ?? (legacy ? readLegacyManual(storage, (_id, error) => { throw error; }) : null);
        current = stored === null ? null : codec.canonical(stored);
      } catch (error) {
        console.warn(`[Library] Kept unreadable ${key} and preserved the incoming snapshot`, error);
        drafts.push(localWorkOriginal(key, source));
        continue;
      }
      if (current === source || (current !== null && sameReportEvidence(JSON.parse(current), JSON.parse(source)))) continue;
      const merge = current === null ? { raw: source, conflict: false }
        : codec.merge?.(current, source) ?? { raw: current, conflict: true };
      if (merge.conflict) drafts.push(localWorkOriginal(key, source));
      if (current !== null && sameReportEvidence(JSON.parse(current), JSON.parse(merge.raw))) continue;
      let raw = merge.raw;
      if (key === SETTINGS_KEY && previous !== null) {
        const settings = decodeStoredSettings(JSON.parse(raw));
        settings.groupBy = decodeStoredSettings(JSON.parse(previous)).groupBy;
        raw = JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings });
      }
      writes.push({ key, previous, raw, source, legacy });
    } catch (error) {
      console.warn(`[Library] Could not plan import of ${key}`, error);
      pending[key] = source;
    }
  }
  return { storage, writes, drafts, pending, canWrite };
}

export function commitLocalWorkImport(plan: ReturnType<typeof planLocalWorkImport>) {
  const { storage, writes, pending } = plan;
  const restored: LocalWorkKey[] = [];
  for (const { key, previous, raw, source, legacy } of writes) {
    try {
      if (!storage || (plan.canWrite && !plan.canWrite(key)) || storage.getItem(key) !== previous
        || (legacy && (storage.getItem(LEGACY_ANSWERS_KEY) !== legacy[0] || storage.getItem(LEGACY_CHECKLIST_KEY) !== legacy[1]))) {
        throw new Error('Saved work changed during import');
      }
      storage.setItem(key, raw);
      restored.push(key);
      if (key === BASELINE_KEY) notifyBaselineChange();
    } catch (error) {
      console.warn(`[Library] Could not restore ${key}; keeping the import available for retry`, error);
      pending[key] = source;
    }
  }
  return { restored, pending };
}
