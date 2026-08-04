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
import { forgetEntryAndBackups, preserveUnreadableEntry } from '../storage/unreadable-entry.js';

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

/**
 * Outcome of a catalog mutation. `persisted: false` means the returned list is
 * what you would see now but NOT what is on disk — the caller must say so
 * rather than showing a filter that vanishes next session (#2089).
 */
export interface SavedFilterMutation {
  presets: SavedFilterPreset[];
  persisted: boolean;
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

/**
 * Set when the stored catalog could neither be parsed nor moved aside. `readRaw`
 * degrades to an empty list, so writing while this is set would serialize that
 * empty list over presets we never managed to read. (#2085)
 */
let catalogUnwritable = false;

function readRaw(): SavedFilterPreset[] {
  const ls = safeStorage();
  if (!ls) return [];
  catalogUnwritable = false;
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
  } catch (err) {
    // Deleting the catalog because we failed to read it is the data loss, not
    // the recovery: move it aside instead, and if even that fails, refuse to
    // write over it. (#2085)
    catalogUnwritable = !preserveUnreadableEntry(ls, STORAGE_KEY, err);
    return [];
  }
}

/**
 * Persist the catalog. Returns false when nothing was written, so a caller can
 * tell the user rather than showing a filter that vanishes next session.
 *
 * The three no-write paths are deliberately distinguished only by the log: a
 * blocked storage policy, a latched refusal to overwrite an unreadable
 * catalog, and a failed write. All three mean "not saved" to the caller.
 */
function writeRaw(list: SavedFilterPreset[]): boolean {
  const ls = safeStorage();
  if (!ls) return false;
  if (catalogUnwritable) {
    console.warn(
      `[ifc-lite] "${STORAGE_KEY}" is preserved as unreadable, so saved filters are not being written. ` +
        `Repair or remove the backup to resume saving.`,
    );
    return false;
  }
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    // Not swallowed, and not described as transient: if the quota is genuinely
    // full, every later attempt fails the same way, so an optimistic "the next
    // save may succeed" would be wrong for the case that actually matters.
    console.warn(`[ifc-lite] saved filters could not be written to "${STORAGE_KEY}".`, err);
    return false;
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
): SavedFilterMutation {
  const trimmed = name.trim();
  // Rejected name: nothing was asked of storage, so nothing is unpersisted.
  if (!trimmed || trimmed.length > MAX_NAME_LEN) return { presets: loadSavedFilters(), persisted: true };

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
  const persisted = writeRaw(sortedByRecency);

  return { presets: loadSavedFilters(), persisted };
}

/** Delete a preset by exact (case-insensitive) name. Returns the new list. */
export function deleteSavedFilter(name: string): SavedFilterMutation {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return { presets: loadSavedFilters(), persisted: true };
  const existing = readRaw();
  const next = existing.filter((p) => p.name.toLowerCase() !== trimmed);
  // Name not found: no write attempted, so nothing is unpersisted.
  if (next.length === existing.length) return { presets: loadSavedFilters(), persisted: true };
  const persisted = writeRaw(next);
  return { presets: loadSavedFilters(), persisted };
}

/** Wipe the entire catalog, including any preserved-but-unreadable copy. */
export function clearSavedFilters(): void {
  const ls = safeStorage();
  if (!ls) return;
  // Explicit, user-initiated — unlike a failed read, this may delete.
  forgetEntryAndBackups(ls, STORAGE_KEY);
  catalogUnwritable = false;
}

export const __internal = { STORAGE_KEY, MAX_ENTRIES, MAX_NAME_LEN };
