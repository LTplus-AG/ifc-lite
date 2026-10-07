/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Moves 2D-drawing persistence saved under a pre-#7035 key (a bare whole-file
 * SHA-256) to the placement-identity key. Imported only when some legacy
 * entry exists; see `drawingPersistenceKey.ts`.
 *
 * The legacy key of a file can only be found by hashing the whole file, so it
 * is computed at most once per `File`, only after the model has finished
 * loading, and counted as `hash.drawingLegacyKey` (not `hash.fullSource`, the
 * per-load passes the benchmark caps). A file whose identity key has been
 * checked is remembered, so legacy entries that belong to OTHER files cost
 * each file one pass, not one per load.
 *
 * ## Never losing an entry
 * Every move is: write under the identity key, read it back, and only then
 * remove the legacy entry. A failed write (quota, private mode) therefore
 * leaves the legacy entry in place and the file unmarked, and the next load
 * tries again. A tab closed between the write and the removal leaves both
 * entries; the retry merges them again, which changes nothing.
 *
 * ## The merge rule
 * Markup items and DXF underlays are independent records with their own `id`,
 * so the entry under the identity key and the legacy one are united.
 *
 * Markup: for an `id` in both, and for the display options, the entry saved
 * later wins (`savedAt`). That is the identity-key entry, written by a viewer
 * that has identity keys, unless a tab still on the previous viewer saved the
 * legacy one afterwards. The section plane is the later entry's too, unless
 * it records none: a stored `null` means that session saved before it
 * generated a drawing (the viewer never saves a plane as cleared), so the
 * other entry's plane is carried over then.
 *
 * DXF underlays: for an `id` in both, the identity-key underlay is kept. The
 * stored time cannot decide here: the restore that runs before this move
 * saves the identity entry again, so it always looks newer.
 *
 * Sheet: the identity-key sheet when there is one, else the legacy sheet.
 */
// TODO(remove-by: browsers no longer hold drawing entries under a bare SHA-256 key, maintainers): delete this module and its two callers in `drawingPersistenceKey.ts` (#7035).

import { perfTally } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import { sha256Hex } from '@/utils/sourceContentHash.js';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { keyFor, loadDrawing2DEntry, saveDrawing2DEntry } from '@/store/slices/drawing2DSlice.persistence.js';
import { loadSheet, saveSheet, sheetStorageKey } from '@/store/slices/sheetSlice.persistence';
import type { LegacyMoveContext } from './drawingPersistenceKey.js';

const legacyKeys = new WeakMap<File, Promise<string | null>>();

/** The key `file`'s drawing persistence was saved under before #7035, or `null` when it cannot be computed. One whole-file pass per `File`. */
function legacyDrawingKey(file: File): Promise<string | null> {
  let pending = legacyKeys.get(file);
  if (!pending) {
    pending = file.arrayBuffer().then((bytes) => {
      perfTally('hash.drawingLegacyKey', bytes.byteLength);
      return sha256Hex(bytes);
    }).catch((err) => {
      console.warn('[drawing2D] could not hash the file to look for markup saved under a legacy key', err);
      return null;
    });
    legacyKeys.set(file, pending);
  }
  return pending;
}

// ── Identity keys already checked against the legacy entries ─────────

const CHECKED_PREFIX = 'ifc-lite:drawing2d-legacy-checked:v1:';
const MAX_CHECKED = 256;
type LegacyStore = 'local' | 'dxf';
/** `checked` identities were compared with the `legacy` keys, the ones stored at that time. */
interface CheckedRecord { legacy: string[]; checked: string[] }

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function readChecked(store: LegacyStore): CheckedRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHECKED_PREFIX + store) ?? '{}') as Partial<CheckedRecord> | null;
    return { legacy: strings(parsed?.legacy), checked: strings(parsed?.checked) };
  } catch (err) {
    console.warn('[drawing2D] could not read the checked legacy keys', err);
    return { legacy: [], checked: [] };
  }
}

/**
 * The earlier checks that still hold now that `present` are the stored legacy
 * keys. A legacy key that was not stored when they were made voids them all:
 * it can only come from a tab still running a viewer from before #7035, and
 * it may belong to a file already checked.
 */
function validChecks(store: LegacyStore, present: string[]): string[] {
  const { legacy, checked } = readChecked(store);
  return present.every((key) => legacy.includes(key)) ? checked : [];
}

function markChecked(store: LegacyStore, key: string, present: string[]): void {
  try {
    const checked = [...validChecks(store, present).filter((other) => other !== key), key].slice(-MAX_CHECKED);
    localStorage.setItem(CHECKED_PREFIX + store, JSON.stringify({ legacy: present, checked } satisfies CheckedRecord));
  } catch (err) {
    // Unmarked only means this file is checked again on its next load.
    console.warn('[drawing2D] could not record a checked legacy key', err);
  }
}

/**
 * Removes a legacy entry once its content is confirmed under the identity key,
 * provided it still holds `moved`, the value that was read for the move. A tab
 * on the previous viewer may have rewritten it since; that entry stays, and so
 * does one that cannot be removed. Returns whether the entry is gone: one that
 * is not must not be recorded as checked, so that the next load handles it.
 */
function removeLocal(storageKey: string, moved: string | null): boolean {
  try {
    if (localStorage.getItem(storageKey) !== moved) return false;
    localStorage.removeItem(storageKey);
    return localStorage.getItem(storageKey) === null;
  } catch (err) {
    console.warn(`[drawing2D] could not remove ${storageKey} after moving it`, err);
    return false;
  }
}

/** The legacy key of `ctx.file`, or `null` when `key` was already checked, the model closed first, or the file cannot be hashed. */
async function legacyKeyToMove(store: LegacyStore, key: string, present: string[], ctx: LegacyMoveContext): Promise<string | null> {
  if (validChecks(store, present).includes(key)) return null;
  if (!await ctx.loaded()) return null;
  return legacyDrawingKey(ctx.file);
}

// ── Markup and sheet (localStorage) ──────────────────────────────────

const MARKUP_LISTS = ['measure2DResults', 'polygonArea2DResults', 'textAnnotations2D', 'cloudAnnotations2D'] as const;
const holdsAll = (stored: { id: string }[], moved: { id: string }[]) => {
  const ids = new Set(stored.map((item) => item.id));
  return moved.every((item) => ids.has(item.id));
};

/** Returns `false` when the legacy markup could not be confirmed under `key` (the legacy entry is then untouched) or could not be removed afterwards. */
function moveLegacyMarkup(key: string, legacy: string, unionById: LegacyMoveContext['unionById']): boolean {
  const defaults = getDefaultDrawing2DState().drawing2DDisplayOptions;
  const raw = localStorage.getItem(keyFor(legacy));
  const old = loadDrawing2DEntry(legacy, defaults);
  if (!old) return true;
  const current = loadDrawing2DEntry(key, defaults);
  // `later` was saved last and wins what the two entries share.
  const later = current && current.savedAt >= old.savedAt ? current : old;
  const earlier = later === old ? current : old;
  const merged = earlier ? {
    ...later,
    measure2DResults: unionById(earlier.measure2DResults, later.measure2DResults),
    polygonArea2DResults: unionById(earlier.polygonArea2DResults, later.polygonArea2DResults),
    textAnnotations2D: unionById(earlier.textAnnotations2D, later.textAnnotations2D),
    cloudAnnotations2D: unionById(earlier.cloudAnnotations2D, later.cloudAnnotations2D),
    sectionConfig: later.sectionConfig ?? earlier.sectionConfig,
  } : later;
  saveDrawing2DEntry(key, merged);
  // The entry read back must hold everything the legacy one contributed. The
  // plane is compared too: when only the plane was missing, an entry whose
  // write failed still holds every item.
  const written = loadDrawing2DEntry(key, defaults);
  if (!written || !MARKUP_LISTS.every((list) => holdsAll(written[list], old[list]))
    || JSON.stringify(written.sectionConfig) !== JSON.stringify(merged.sectionConfig)) return false;
  return removeLocal(keyFor(legacy), raw);
}

/** Returns `false` when the legacy sheet could not be confirmed under `key` (the legacy entry is then untouched) or could not be removed afterwards. */
function moveLegacySheet(key: string, legacy: string): boolean {
  const raw = localStorage.getItem(sheetStorageKey(legacy));
  const old = loadSheet(legacy);
  if (!old) return true;
  if (!loadSheet(key)) {
    saveSheet(key, old);
    if (!loadSheet(key)) return false;
  }
  return removeLocal(sheetStorageKey(legacy), raw);
}

/**
 * Moves the file's markup and sheet from its legacy key to `key`, unless `key`
 * was already checked or the model closed first. `present` are the localStorage
 * keys of the legacy entries stored right now.
 */
export async function migrateLegacyLocalEntries(key: string, present: string[], ctx: LegacyMoveContext): Promise<void> {
  const legacy = await legacyKeyToMove('local', key, present, ctx);
  if (!legacy) return;
  const markup = moveLegacyMarkup(key, legacy, ctx.unionById);
  const sheet = moveLegacySheet(key, legacy);
  // Checked against what is left: an entry that reappears under a removed key is new.
  const removed = [keyFor(legacy), sheetStorageKey(legacy)].filter((moved) => localStorage.getItem(moved) === null);
  if (markup && sheet) markChecked('local', key, present.filter((other) => !removed.includes(other)));
}

// ── DXF underlays (IndexedDB) ────────────────────────────────────────

/**
 * What identifies one write of a raw stored entry: its save time and the ids
 * of its underlays, in order. Every save stamps a new time, so this also
 * changes when an underlay is edited in place.
 */
function writeStamp(entry: unknown): string {
  const { dxfUnderlays, savedAt } = (entry ?? {}) as { dxfUnderlays?: unknown; savedAt?: unknown };
  return JSON.stringify([savedAt ?? null, Array.isArray(dxfUnderlays) ? dxfUnderlays.map((underlay) => (underlay as { id?: unknown } | null)?.id ?? null) : null]);
}

/**
 * Moves the file's DXF underlays from its legacy key to `key`. Runs after
 * `key`'s restore settled, so when the model is still active the legacy
 * underlays are added to the live list and the ordinary save writes the
 * union; otherwise the stored list is extended directly.
 */
export async function migrateLegacyDxfEntry(key: string, present: string[], ctx: LegacyMoveContext, stillCurrent: () => boolean): Promise<void> {
  const legacy = await legacyKeyToMove('dxf', key, present, ctx);
  if (!legacy) return;
  let left = present;
  const { dxf } = ctx;
  const hasLegacy = present.includes(legacy);
  // The entry's write stamp as stored now, to tell at removal time whether a
  // tab on the previous viewer rewrote the entry meanwhile. This read also rejects
  // when the entry cannot be read, which leaves the identity unmarked for the
  // next load: `load` below answers `null` for a failed read and for an
  // unreadable value alike, and only the second may be recorded as checked.
  const seen = hasLegacy ? writeStamp(await dxf.request('readonly', (store) => store.get(legacy))) : '';
  const old = hasLegacy ? await dxf.load(legacy) : null;
  if (old) {
    const moved = old.dxfUnderlays;
    if (stillCurrent()) {
      const live = useViewerStore.getState().dxfUnderlays;
      const merged = dxf.merge(live, moved);
      if (merged !== live) useViewerStore.setState({ dxfUnderlays: merged });
    }
    const stored = async () => {
      await dxf.saved(key);
      return (await dxf.load(key))?.dxfUnderlays ?? [];
    };
    let now = await stored();
    if (!holdsAll(now, moved)) {
      await dxf.save(key, dxf.merge(now, moved));
      now = await stored();
    }
    if (!holdsAll(now, moved)) return; // not confirmed: the legacy entry stays for the next load
    // Read and delete in ONE transaction, so nothing can be added to the
    // legacy entry between the comparison and the removal.
    let removed = false;
    await dxf.request('readwrite', (store) => {
      const read = store.get(legacy);
      read.addEventListener('success', () => {
        if (writeStamp(read.result) !== seen) return;
        store.delete(legacy);
        removed = true;
      });
      return read;
    });
    if (!removed) return; // rewritten meanwhile: it stays for the next load
    left = present.filter((other) => other !== legacy);
  }
  markChecked('dxf', key, left);
}
