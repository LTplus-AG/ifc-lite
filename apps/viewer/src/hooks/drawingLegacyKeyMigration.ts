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
 * An entry already under the identity key was written by a viewer that has
 * identity keys, so it is at least as new as the legacy one. Markup items and
 * DXF underlays are independent records with their own `id`, so the two sets
 * are united and, for an `id` in both, the identity-key item is kept. Values
 * that cannot be united (display options, section plane, the sheet) come from
 * the identity-key entry when it has one and from the legacy entry otherwise.
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

function removeLocal(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch (err) {
    console.warn(`[drawing2D] could not remove ${storageKey} after moving it`, err);
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

/** Returns `false` when the legacy markup could not be confirmed under `key`; the legacy entry is then still in place. */
function moveLegacyMarkup(key: string, legacy: string, unionById: LegacyMoveContext['unionById']): boolean {
  const defaults = getDefaultDrawing2DState().drawing2DDisplayOptions;
  const old = loadDrawing2DEntry(legacy, defaults);
  if (!old) return true;
  const current = loadDrawing2DEntry(key, defaults);
  saveDrawing2DEntry(key, current ? {
    ...current,
    measure2DResults: unionById(old.measure2DResults, current.measure2DResults),
    polygonArea2DResults: unionById(old.polygonArea2DResults, current.polygonArea2DResults),
    textAnnotations2D: unionById(old.textAnnotations2D, current.textAnnotations2D),
    cloudAnnotations2D: unionById(old.cloudAnnotations2D, current.cloudAnnotations2D),
    sectionConfig: current.sectionConfig ?? old.sectionConfig,
  } : old);
  const written = loadDrawing2DEntry(key, defaults);
  if (!written || !MARKUP_LISTS.every((list) => holdsAll(written[list], old[list]))) return false;
  removeLocal(keyFor(legacy));
  return true;
}

/** Returns `false` when the legacy sheet could not be confirmed under `key`; the legacy entry is then still in place. */
function moveLegacySheet(key: string, legacy: string): boolean {
  const old = loadSheet(legacy);
  if (!old) return true;
  if (!loadSheet(key)) {
    saveSheet(key, old);
    if (!loadSheet(key)) return false;
  }
  removeLocal(sheetStorageKey(legacy));
  return true;
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
  const old = await dxf.load(legacy);
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
    await dxf.request('readwrite', (store) => store.delete(legacy));
    left = present.filter((other) => other !== legacy);
  }
  markChecked('dxf', key, left);
}
