/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { saveJson, type SaveResult } from './save-result.js';

/** Known neighboring rows remain usable; they never prove a complete read. */
export interface LocalLibrarySource<T> {
  phase: 'absent' | 'ready' | 'unreadable' | 'unavailable';
  rows: T[];
  raw: string | null;
}

/** Native family codecs own every migration and validation decision (#7300). */
export function readLocalLibrary<T>(key: string, decode: (value: unknown) => T | null): LocalLibrarySource<T> {
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch (error) {
    console.warn(`[Library] Could not read ${key}; its originals remain untouched.`, error);
    return { phase: 'unavailable', rows: [], raw: null };
  }
  if (raw === null) return { phase: 'absent', rows: [], raw };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    console.warn(`[Library] Could not parse ${key}; its originals remain untouched.`, error);
    return { phase: 'unreadable', rows: [], raw };
  }
  if (!Array.isArray(parsed)) return { phase: 'unreadable', rows: [], raw };
  const rows: T[] = [];
  let phase: 'ready' | 'unreadable' = 'ready';
  for (const entry of parsed) {
    try {
      const row = decode(entry);
      if (row === null) phase = 'unreadable';
      else rows.push(row);
    } catch (error) {
      console.warn(`[Library] Could not read a saved entry in ${key}; its originals remain untouched.`, error);
      phase = 'unreadable';
    }
  }
  return { phase, rows, raw };
}

/** Fresh source checks precede serialization and the final synchronous write.
 * This is a refusal boundary, not a transaction across browser libraries. */
export function saveLocalLibrary<T>(key: string, value: unknown, source: LocalLibrarySource<T>, subject: string): SaveResult {
  if (source.phase === 'unreadable') return { ok: false, reason: 'unavailable',
    message: `The saved library includes unreadable content — ${subject} were not saved. Originals were left untouched; export current drafts and recover the saved library before retrying.` };
  if (source.phase === 'unavailable') return { ok: false, reason: 'unavailable',
    message: `Browser storage could not be read — ${subject} were not saved. Originals were left untouched.` };
  return saveJson(key, value, subject, () => {
    try {
      if (localStorage.getItem(key) !== source.raw) return { ok: false, reason: 'unavailable',
        message: `Saved ${subject} changed while saving. Originals were left untouched; reload the browser library before retrying.` };
      return { ok: true };
    } catch (error) {
      console.warn(`[Library] Could not recheck ${key}; its originals remain untouched.`, error);
      return { ok: false, reason: 'unavailable', message: `Browser storage could not be read — ${subject} were not saved.` };
    }
  });
}
