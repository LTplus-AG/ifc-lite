/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved filter presets — localStorage-backed catalog of named
 * `FilterRule[]` snapshots. Mirrors the `filter_presets` table from
 * the Tauri-side `filter.rs` engine: each preset stores a name, the
 * rule list, and the AND/OR combinator. Presets are surfaced in the
 * builder toolbar as a dropdown; clicking one replaces the current
 * filter state.
 *
 * Pure module — safe to import from tests (stubs storage when
 * `window.localStorage` is unavailable). Names are trimmed and
 * deduplicated by case-insensitive match, so re-saving a preset under
 * the same name overwrites it (matching the Rust ON CONFLICT behaviour).
 */

import {
  parseFilterRules,
  type Combinator,
  type FilterRule,
} from './filter-rules.js';

const STORAGE_KEY = 'ifc-lite:search:saved-filters';
const MAX_ENTRIES = 50;
const MAX_NAME_LEN = 80;

export interface SavedFilterPreset {
  name: string;
  combinator: Combinator;
  rules: FilterRule[];
  /** Wall-clock ms when this preset was last written. */
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
    /* localStorage unavailable (private browsing, sandboxed iframe,
     * Safari quota probe failure). The catch is intentional — feature
     * silently degrades to in-memory only; a thrown error here would
     * crash the modal on every open. */
    return null;
  }
}

function readRaw(): SavedFilterPreset[] {
  const ls = safeStorage();
  if (!ls) return [];
  const raw = ls.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SavedFilterPreset[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!name || name.length > MAX_NAME_LEN) continue;
      const combinator: Combinator = o.combinator === 'OR' ? 'OR' : 'AND';
      const rules = parseFilterRules(o.rules);
      const updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : Date.now();
      out.push({ name, combinator, rules, updatedAt });
    }
    return out;
  } catch {
    ls.removeItem(STORAGE_KEY);
    return [];
  }
}

function writeRaw(list: SavedFilterPreset[]): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded — swallow; the next save attempt may succeed.
  }
}

/** All saved presets, sorted by name (A→Z) for stable UI ordering. */
export function loadSavedFilters(): SavedFilterPreset[] {
  const list = readRaw();
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/**
 * Insert or update a preset by case-insensitive name match. Returns the
 * resulting full catalog (sorted) so callers can refresh UI without a
 * second read.
 */
export function saveFilter(
  name: string,
  combinator: Combinator,
  rules: readonly FilterRule[],
): SavedFilterPreset[] {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LEN) return loadSavedFilters();

  const existing = readRaw();
  const idx = existing.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const preset: SavedFilterPreset = {
    name: trimmed,
    combinator,
    // Defensive copy so callers can mutate their own array without
    // corrupting the saved list (they share references via parseFilterRules
    // on read, but write should snapshot).
    rules: rules.map((r) => ({ ...r }) as FilterRule),
    updatedAt: Date.now(),
  };
  if (idx >= 0) existing[idx] = preset;
  else existing.unshift(preset);

  // Cap on size — newest survive when capacity overflows.
  const sortedByRecency = existing
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES);
  writeRaw(sortedByRecency);

  return loadSavedFilters();
}

/** Delete a preset by exact (case-insensitive) name. Returns the new list. */
export function deleteSavedFilter(name: string): SavedFilterPreset[] {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return loadSavedFilters();
  const existing = readRaw();
  const next = existing.filter((p) => p.name.toLowerCase() !== trimmed);
  if (next.length === existing.length) return loadSavedFilters();
  writeRaw(next);
  return loadSavedFilters();
}

/** Wipe the entire catalog. */
export function clearSavedFilters(): void {
  const ls = safeStorage();
  if (!ls) return;
  ls.removeItem(STORAGE_KEY);
}

export const __internal = { STORAGE_KEY, MAX_ENTRIES, MAX_NAME_LEN };
