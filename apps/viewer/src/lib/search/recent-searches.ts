/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recent searches — small localStorage-backed MRU list surfaced in the
 * search popover when the field is focused with an empty query.
 *
 * Pure module — safe to import from tests (stubs a storage object when
 * `window.localStorage` is not present). All entries are trimmed
 * non-empty strings; exact-duplicate entries are moved to the front
 * instead of appended, giving a natural MRU without bookkeeping.
 */

const STORAGE_KEY = 'ifc-lite:search:recents';
const MAX_ENTRIES = 8;
const MAX_QUERY_LEN = 200;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    const ls = (globalThis as typeof globalThis & { localStorage?: StorageLike }).localStorage;
    if (!ls) return null;
    // Some environments (sandbox, private mode) throw on write — probe it.
    const probe = `${STORAGE_KEY}:__probe__`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** Returns the MRU list, most-recent first. Always a fresh array. */
export function loadRecentSearches(): string[] {
  const ls = safeStorage();
  if (!ls) return [];
  const raw = ls.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed.length > 0 && trimmed.length <= MAX_QUERY_LEN) out.push(trimmed);
      }
      if (out.length >= MAX_ENTRIES) break;
    }
    return out;
  } catch {
    // Malformed payload — drop it rather than letting it block future writes.
    ls.removeItem(STORAGE_KEY);
    return [];
  }
}

/** Record a committed query. No-ops on empty/whitespace input. */
export function pushRecentSearch(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUERY_LEN) return loadRecentSearches();
  const existing = loadRecentSearches();
  // Move-to-front: remove any prior exact match, then prepend.
  const deduped = existing.filter((q) => q !== trimmed);
  const next = [trimmed, ...deduped].slice(0, MAX_ENTRIES);

  const ls = safeStorage();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or unexpected write failure — swallow; the next
      // pushRecentSearch call may succeed once other storage is freed.
    }
  }
  return next;
}

/** Wipe the list. Useful for privacy + the "Clear recents" UI affordance. */
export function clearRecentSearches(): void {
  const ls = safeStorage();
  if (!ls) return;
  ls.removeItem(STORAGE_KEY);
}

/** Exposed for tests. */
export const __internal = { STORAGE_KEY, MAX_ENTRIES, MAX_QUERY_LEN };
