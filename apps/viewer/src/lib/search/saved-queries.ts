/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved SQL queries — localStorage-backed library surfaced in the
 * SQL tab's "My queries" dropdown.
 *
 * Each entry has a stable id (millis + counter) plus a user-chosen
 * name. The list is capped at MAX_ENTRIES so localStorage doesn't
 * grow unbounded; oldest entries are evicted when the cap is hit.
 *
 * The same defensive-storage pattern as recent-searches is used —
 * a probe-write decides whether to engage or fall back silently,
 * malformed payloads get auto-cleared, sandbox / quota / private-
 * browsing failures are swallowed so the UI keeps working.
 */

const STORAGE_KEY = 'ifc-lite:search:saved-queries';
const MAX_ENTRIES = 50;
const MAX_NAME_LEN = 120;
const MAX_SQL_LEN = 100_000;

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    const ls = (globalThis as typeof globalThis & { localStorage?: StorageLike }).localStorage;
    if (!ls) return null;
    const probe = `${STORAGE_KEY}:__probe__`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function isValidEntry(v: unknown): v is SavedQuery {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<SavedQuery>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.name === 'string' && r.name.length > 0 && r.name.length <= MAX_NAME_LEN &&
    typeof r.sql === 'string' && r.sql.length > 0 && r.sql.length <= MAX_SQL_LEN &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number'
  );
}

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `q-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Returns the saved-queries list, most-recently-updated first. */
export function loadSavedQueries(): SavedQuery[] {
  const ls = safeStorage();
  if (!ls) return [];
  const raw = ls.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      ls.removeItem(STORAGE_KEY);
      return [];
    }
    return parsed.filter(isValidEntry).slice(0, MAX_ENTRIES);
  } catch {
    ls.removeItem(STORAGE_KEY);
    return [];
  }
}

function persist(list: SavedQuery[]): SavedQuery[] {
  const ls = safeStorage();
  if (!ls) return list;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded — drop the oldest half and retry once. If that
    // still fails, give up so the UI doesn't hang.
    try {
      const trimmed = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
      ls.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch {
      // swallow — caller still gets the in-memory list
    }
  }
  return list;
}

/** Append a new query (or no-op when name/sql are empty). Returns the new list. */
export function saveQuery(name: string, sql: string): SavedQuery[] {
  const trimmedName = name.trim();
  const trimmedSql = sql.trim();
  if (trimmedName.length === 0 || trimmedSql.length === 0) return loadSavedQueries();
  if (trimmedName.length > MAX_NAME_LEN || trimmedSql.length > MAX_SQL_LEN) return loadSavedQueries();

  const now = Date.now();
  const entry: SavedQuery = {
    id: generateId(),
    name: trimmedName,
    sql: trimmedSql,
    createdAt: now,
    updatedAt: now,
  };
  // Newest first; cap the list size.
  const next = [entry, ...loadSavedQueries()].slice(0, MAX_ENTRIES);
  return persist(next);
}

/** Patch a saved query by id. Caller-supplied `updatedAt` is ignored. */
export function updateSavedQuery(
  id: string,
  patch: Partial<Pick<SavedQuery, 'name' | 'sql'>>,
): SavedQuery[] {
  const list = loadSavedQueries();
  // Compute an updatedAt that is strictly greater than any existing
  // entry's, so the edited entry sorts to the top even when Date.now()
  // resolution clamps multiple operations to the same millisecond.
  const maxExisting = list.reduce((m, q) => Math.max(m, q.updatedAt), 0);
  const newTimestamp = Math.max(Date.now(), maxExisting + 1);
  const next = list.map((q) => {
    if (q.id !== id) return q;
    const name = patch.name?.trim() ?? q.name;
    const sql = patch.sql?.trim() ?? q.sql;
    if (name.length === 0 || name.length > MAX_NAME_LEN) return q;
    if (sql.length === 0 || sql.length > MAX_SQL_LEN) return q;
    return { ...q, name, sql, updatedAt: newTimestamp };
  });
  // Move the freshly-edited entry to the top of the list.
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return persist(next);
}

/** Drop a saved query by id. */
export function deleteSavedQuery(id: string): SavedQuery[] {
  const next = loadSavedQueries().filter((q) => q.id !== id);
  return persist(next);
}

/** Wipe every saved query. Useful for the privacy / "Clear all" action. */
export function clearSavedQueries(): void {
  const ls = safeStorage();
  if (!ls) return;
  ls.removeItem(STORAGE_KEY);
}

/** Exposed for tests. */
export const __internal = { STORAGE_KEY, MAX_ENTRIES, MAX_NAME_LEN, MAX_SQL_LEN };
