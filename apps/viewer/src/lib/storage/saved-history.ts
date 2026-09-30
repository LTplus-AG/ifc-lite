/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { optionalLocalStorage, preserveUnreadableEntry } from './unreadable-entry';
import { saveJson, type SaveResult } from './save-result';

export type SavedHistoryIssue = 'recovered' | 'blocked' | 'unavailable';
export type SavedHistorySave<T> = SaveResult & { issue: SavedHistoryIssue | null; entries: T[] };
export interface SavedHistoryRead<T> {
  entries: T[];
  issue: SavedHistoryIssue | null;
}

/** Portable saved reports share one recovery policy, including partial arrays. */
export function createSavedHistoryStorage<T extends { id: string }>(
  key: string,
  isEntry: (value: unknown) => value is T,
  subject: string,
): { read: () => SavedHistoryRead<T>; save: (entries: readonly T[]) => SavedHistorySave<T> } {
  let inspectionUnavailable = false;
  const unavailable = (): SaveResult => ({
    ok: false, reason: 'unavailable', message: `Browser storage is unavailable — ${subject} were not saved.`,
  });
  const read = (): SavedHistoryRead<T> => {
    const storage = optionalLocalStorage();
    if (!storage) { inspectionUnavailable = true; return { entries: [], issue: 'unavailable' }; }
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (error) {
      inspectionUnavailable = true;
      console.warn(`[ifc-lite] Could not read ${subject}.`, error);
      return { entries: [], issue: 'unavailable' };
    }
    inspectionUnavailable = false;
    if (raw === null) return { entries: [], issue: null };
    const entries: T[] = [];
    let cause: unknown;
    let damaged = false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Saved history must be an array.');
      const seen = new Set<string>();
      for (const entry of parsed) {
        if (!isEntry(entry) || seen.has(entry.id)) {
          damaged = true;
          cause = new Error('Saved history contains invalid or duplicate entries.');
          continue;
        }
        seen.add(entry.id);
        entries.push(entry);
      }
    } catch (error) {
      damaged = true;
      cause = error;
    }
    if (!damaged) return { entries, issue: null };
    // Archive the COMPLETE original before restoring valid neighbours. Dropped
    // entries and duplicate versions must remain recoverable byte for byte.
    if (!preserveUnreadableEntry(storage, key, cause)) return { entries, issue: 'blocked' };
    const restored = saveJson(key, entries, subject);
    return { entries, issue: restored.ok ? 'recovered' : 'unavailable' };
  };
  return {
    read,
    save: (entries) => {
      // Inspect again before every write: another tab may have replaced the
      // entry, or storage may have become available since initialization.
      const previouslyUnavailable = inspectionUnavailable;
      const current = read();
      if (current.issue === 'blocked' || current.issue === 'unavailable') return { ...unavailable(), issue: current.issue, entries: [...entries] };
      // A failed initial inspection cannot authorize replacing valid reports
      // that become readable later. Incoming edits win matching ids; ordinary
      // writes after a complete read still support explicit deletions.
      const retained = new Map(previouslyUnavailable ? current.entries.map((entry) => [entry.id, entry]) : []);
      for (const entry of entries) retained.set(entry.id, entry);
      const saved = [...retained.values()];
      const result = saveJson(key, saved, subject);
      if (!result.ok && previouslyUnavailable) inspectionUnavailable = true;
      return { ...result, issue: result.ok ? current.issue : 'unavailable', entries: saved };
    },
  };
}
