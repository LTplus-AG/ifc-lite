/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A localStorage-backed "Recent" list of definition files opened or saved
 * from the Data validation panel: rule sets (#5138 plan §6) and manual
 * checklists (#6401) each get one cache, under their own key. Path-less by
 * design (a browser file picker never returns a reusable path): it stores
 * the file CONTENT, the same posture `lib/search/saved-filters.ts` uses for
 * saved filter presets, capped at 10 entries x 256 KB so a large file can't
 * fill the origin's quota.
 */

import { optionalLocalStorage } from '../storage/unreadable-entry.js';

const MAX_ENTRIES = 10;
const MAX_BYTES = 256 * 1024;

export interface RecentFile {
  /** The definition's own `name` field, for display — not a filename. */
  name: string;
  /** The full file text, re-parsed by the owner on open. */
  content: string;
  savedAt: number;
}

export interface RecentFileCache {
  /** Every cached entry, most-recently-saved first. Never throws — a
   *  corrupt/oversized/blocked catalog reads back as empty. */
  load: () => RecentFile[];
  /**
   * Cache `content` under `name`, replacing any existing entry with the same
   * name and evicting the oldest once the cap is reached. An entry over
   * `MAX_BYTES` is silently NOT cached (the file itself is still
   * saved/opened normally — this cache is a convenience, not the source of
   * truth) rather than failing the caller's save/open action.
   */
  add: (name: string, content: string) => RecentFile[];
  /** Drop the entry named `name` (a cached file that turned out to be
   *  unreadable). Returns the resulting list so callers can refresh UI
   *  without a second read. */
  remove: (name: string) => RecentFile[];
}

function isRecentFile(v: unknown): v is RecentFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string' && typeof o.content === 'string' && typeof o.savedAt === 'number';
}

export function createRecentFileCache(storageKey: string, label: string): RecentFileCache {
  const load = (): RecentFile[] => {
    const storage = optionalLocalStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecentFile).sort((a, b) => b.savedAt - a.savedAt);
    } catch (error) {
      console.warn(`[ifc-lite] ${label} in "${storageKey}" could not be read; showing none.`, error);
      return [];
    }
  };

  const write = (next: RecentFile[]): boolean => {
    const storage = optionalLocalStorage();
    if (!storage) return true;
    try {
      storage.setItem(storageKey, JSON.stringify(next));
      return true;
    } catch (error) {
      console.warn(`[ifc-lite] ${label} could not be written to "${storageKey}".`, error);
      return false;
    }
  };

  return {
    load,
    add: (name, content) => {
      const existing = load();
      if (content.length > MAX_BYTES) return existing;
      const next = [
        { name, content, savedAt: Date.now() },
        ...existing.filter((e) => e.name !== name),
      ].slice(0, MAX_ENTRIES);
      return write(next) ? next : existing;
    },
    remove: (name) => {
      const next = load().filter((e) => e.name !== name);
      write(next);
      return next;
    },
  };
}
