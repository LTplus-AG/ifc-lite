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
} from '@ifc-lite/rules';
import { emptyFilterGroup, parseFilterGroups, type FilterGroup } from '@ifc-lite/rules';
import { forgetEntryAndBackups, preserveUnreadableEntry } from '../storage/unreadable-entry.js';

const STORAGE_KEY = 'ifc-lite:search:saved-filters';
const MAX_ENTRIES = 50;
const MAX_NAME_LEN = 80;

/**
 * On-disk schema version (#4904). Absent (or `1`) is the pre-groups shape:
 * `{ name, combinator, rules, updatedAt }`, read as one implicit group —
 * every preset saved before this change, with NO forced rewrite. `2` is
 * `{ name, schemaVersion: 2, groups, updatedAt }`, PLUS a top-level
 * `rules`/`combinator` mirroring `groups[0]` — but ONLY when there is
 * exactly one group. A real `+` union (`groups.length > 1`) omits them on
 * purpose: `rules`/`combinator` alone could only ever show the first
 * OR-branch, and a build that predates groups (reading the raw catalog with
 * its own `Array.isArray(o.rules)` check) must skip that entry rather than
 * silently read only its first group as if it were the whole filter. The
 * single-group case has no such risk — there is nothing left to narrow away
 * — so it stays visible to `ownAppearanceQuery`
 * (`lib/appearance/query-definition.ts`), the one reader that predates
 * groups, validates the RAW on-disk shape directly (see `readRaw`), and
 * stays single-group on purpose (no union concept to route `groups`
 * through). `SavedFilterPreset` (the in-memory shape below) always carries
 * `rules`/`combinator` as a `groups[0]` alias, regardless of version.
 */
const SCHEMA_VERSION = 2;

export interface SavedFilterPreset {
  name: string;
  /** Every OR'd group (#4904). Length 1 for a union-free preset — every
   *  preset saved before this change, and the common case since. */
  groups: FilterGroup[];
  /** Convenience alias for `groups[0]?.combinator` — see `SCHEMA_VERSION` doc. */
  combinator: Combinator;
  /** Convenience alias for `groups[0]?.rules ?? []` — see `SCHEMA_VERSION` doc. */
  rules: FilterRule[];
  /** Wall-clock ms when this preset was last written. */
  updatedAt: number;
}

/**
 * Outcome of a catalog mutation. `persisted: false` means the write did not
 * reach storage: `presets` is a fresh re-read of what is actually on disk —
 * the prior readable catalog, not the attempted mutation — so it will not
 * include the preset just saved (or will still include one just "deleted").
 * The caller must say so explicitly rather than showing the attempted change
 * as if it were saved, only for it to be gone next session (#2089).
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

/** One catalog entry's groups, from either on-disk shape. `null` means this
 *  ONE entry is unreadable (a v2 entry with a group this build's
 *  `isFilterRule` doesn't recognise) — the caller skips just that preset,
 *  not the whole catalog. v1 has no such refusal: an individual unreadable
 *  RULE inside it is silently dropped by `parseFilterRules`, unchanged
 *  pre-#4904 behaviour that stays for the implicit-single-group case. */
function readGroups(o: Record<string, unknown>): FilterGroup[] | null {
  // `schemaVersion` ABSENT means v1 (the pre-#4904 shape). PRESENT but not a
  // number (`"2"`, `null`, …) is corruption, not "no version" — review (PR
  // #4987) caught that coercing a non-number to v1 silently read a v2
  // preset's OMITTED `rules`/`combinator` as an empty filter instead of
  // refusing the unreadable entry.
  // Pre-#4904 builds never wrote a version; a literal `1` is accepted as the
  // same shape in case a hand-edited export names it.
  if (o.schemaVersion === undefined || o.schemaVersion === 1) {
    const combinator: Combinator = o.combinator === 'OR' ? 'OR' : 'AND';
    return [{ rules: parseFilterRules(o.rules), combinator }];
  }
  if (typeof o.schemaVersion !== 'number') return null;
  // Exactly v2 — a version this build does not recognise (a future v3, …)
  // must refuse too, not fall through the v2 `groups` parser: review (PR
  // #4987) caught that `>= 2` treated an incompatible future shape as an
  // ordinary v2 read, which (combined with `writeRaw` only ever
  // serializing what `readRaw` returned) would permanently drop it from
  // the catalog on the very next save.
  if (o.schemaVersion !== 2) return null;
  return parseFilterGroups(o.groups);
}

function readRaw(validate?: (preset: unknown) => unknown): SavedFilterPreset[] {
  const ls = safeStorage();
  if (!ls) return [];
  catalogUnwritable = false;
  const raw = ls.getItem(STORAGE_KEY);
  // '' (empty string) is a distinct, corrupt entry, not "nothing saved" (null)
  // -- it must still reach JSON.parse so the catch below quarantines it via
  // `preserveUnreadableEntry`, the same way a truncated/hand-edited catalog
  // does. Collapsing the two here bypassed that path entirely: an empty
  // string never threw, so `catalogUnwritable` was never latched and the
  // next ordinary save silently overwrote the corrupt entry unprotected.
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Valid JSON, wrong shape — a future format wrapping the array in an
      // object, or a hand-edited file. This is not a parse error, but it is
      // just as unreadable to this loader: it must go through the same
      // preserve-and-quarantine path as the catch below, not a silent `[]`
      // that the next ordinary save would serialize over the entry. (#2089
      // review)
      catalogUnwritable = !preserveUnreadableEntry(ls, STORAGE_KEY, new Error('saved filter catalog is not an array'));
      return [];
    }
    const out: SavedFilterPreset[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!name || name.length > MAX_NAME_LEN) continue;

      const groups = readGroups(o);
      if (groups === null) {
        // Unreadable groups: skip this ONE entry from the returned list
        // (not the whole catalog, per the module doc), but ALSO latch
        // `catalogUnwritable` — review (PR #4987) caught that without this,
        // the very next `saveFilter`/`deleteSavedFilter` calls `writeRaw`
        // with the reduced (survivors-only) list, which permanently
        // deletes the unreadable entry instead of merely hiding it. Same
        // "preserve, don't destroy, what we failed to read" principle the
        // whole-catalog corruption path below already applies (#2085).
        catalogUnwritable = true;
        console.warn(
          `[ifc-lite] Saved filter "${name}" has an unreadable group (unknown rule kind/op, ` +
            `bad combinator, or an unsupported schema version) and will not be shown. Saving or ` +
            `deleting ANY other preset is blocked until it is repaired or removed by hand, so it ` +
            `is not silently lost the next time the catalog is written.`,
        );
        continue;
      }
      const updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : Date.now();
      const preset: SavedFilterPreset = {
        name,
        groups,
        combinator: groups[0]?.combinator ?? 'AND',
        rules: groups[0]?.rules ?? [],
        updatedAt,
      };

      // `validate` runs against the RAW JSON, unchanged from before #4904 —
      // NOT the normalized `preset` above. `ownAppearanceQuery` (the one
      // caller that passes one) checks `rules`/`combinator` directly against
      // whatever it is handed; validating the raw v1 shape is what lets it
      // reject a v1 entry carrying an unreadable rule entirely (a dropped AND
      // predicate would BROADEN what the saved query matches, #4404) instead
      // of silently accepting the survivors `parseFilterRules` already
      // filtered down to. A v2 entry has no top-level `rules` on disk at all
      // (see `SCHEMA_VERSION` doc) — `ownAppearanceQuery(o)` rejects it the
      // same way, so appearance's saved-filter dropdown simply does not list
      // a preset saved after #4904 yet. That is an accepted, documented gap:
      // appearance scope stays single-group and has no union concept to
      // route `groups` through.
      if (validate) {
        try { validate(o); }
        catch (error) {
          console.warn(`[ifc-lite] Saved filter "${name}" is unavailable for this operation.`, error);
          continue;
        }
      }
      out.push(preset);
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
    // On-disk v2 shape deliberately omits `rules`/`combinator` — see
    // `SCHEMA_VERSION`'s doc comment on why a pre-groups build must fail to
    // read this rather than silently seeing only the first group.
    // A single-group preset (every preset before #4904, and still the
    // common case) ALSO writes the legacy `rules`/`combinator` fields — they
    // exactly mirror `groups[0]`, so a v1-only reader (or `ownAppearanceQuery`,
    // which validates this raw shape directly, see `readRaw`) sees the whole
    // filter and keeps working unchanged. A real union (`groups.length > 1`)
    // omits them ON PURPOSE: `rules`/`combinator` alone could only ever show
    // the first OR-branch, and a reader taking that as the whole filter would
    // silently narrow a `+` union rather than fail to read it — see
    // `SCHEMA_VERSION`'s doc comment.
    const onDisk = list.map((p) => ({
      name: p.name,
      schemaVersion: SCHEMA_VERSION,
      groups: p.groups,
      ...(p.groups.length === 1 ? { combinator: p.groups[0].combinator, rules: p.groups[0].rules } : {}),
      updatedAt: p.updatedAt,
    }));
    ls.setItem(STORAGE_KEY, JSON.stringify(onDisk));
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
export function loadSavedFilters(validate?: (preset: unknown) => unknown): SavedFilterPreset[] {
  const list = readRaw(validate);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/**
 * Insert or update a preset by case-insensitive name match. Returns the
 * resulting full catalog (sorted) so callers can refresh UI without a
 * second read.
 */
export function saveFilter(name: string, groups: readonly FilterGroup[]): SavedFilterMutation {
  const trimmed = name.trim();
  // Rejected name: nothing was asked of storage, so nothing is unpersisted.
  if (!trimmed || trimmed.length > MAX_NAME_LEN) return { presets: loadSavedFilters(), persisted: true };
  const savedGroups: FilterGroup[] = groups.length > 0 ? groups.map((g) => ({
    // Defensive copy so callers can mutate their own array without
    // corrupting the saved list (they share references via parseFilterGroups
    // on read, but write should snapshot).
    rules: g.rules.map((r) => ({ ...r }) as FilterRule),
    combinator: g.combinator,
  })) : [emptyFilterGroup()];

  const existing = readRaw();
  const idx = existing.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const preset: SavedFilterPreset = {
    name: trimmed,
    groups: savedGroups,
    combinator: savedGroups[0]?.combinator ?? 'AND',
    rules: savedGroups[0]?.rules ?? [],
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
