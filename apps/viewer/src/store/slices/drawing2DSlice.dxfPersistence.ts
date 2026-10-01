/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB persistence for `dxfUnderlays` (issue #4153, reopened — the four
 * merged PRs persisted the other five `Drawing2DState` markup fields to
 * `localStorage`, via `drawing2DSlice.persistence.ts`, and deliberately left
 * `dxfUnderlays` out: an imported DXF underlay can embed arbitrary point
 * counts, plausibly over `localStorage`'s ~5MB synchronous budget. This
 * module is that follow-up, on IndexedDB instead — the same convention
 * `services/extensions/idb-storage.ts` already uses (single DB, versioned
 * `onupgradeneeded`, recreate-from-scratch recovery if a store is missing).
 *
 * Kept in a sibling file rather than inline in `drawing2DSlice.ts` for the
 * same reason `drawing2DSlice.persistence.ts` is: that slice is at its
 * recorded module-size budget (`scripts/module-size-allowlist.txt`).
 *
 * ## Why this is NOT keyed, cleared, or restored the way the other five
 * fields are
 * `drawing2DSlice.markupTransition.ts`'s `FIELD_CLASSIFICATION` marks
 * `dxfUnderlays` `'preserved'` — unlike the five `'committed'` markup
 * fields, it is never cleared and never restored on an `activeModelId`
 * transition; a DXF reference drawing belongs to the workspace, not to
 * whichever model happens to be active (see that module's doc and issue
 * #2802). So this module's IndexedDB entries are keyed by content hash the
 * same way the markup entries are — the only stable per-model identity
 * available — but the RESTORE side (`mergeDxfUnderlays`, consumed by
 * `hooks/dxfUnderlaySave.ts`) is additive, never replacing: it adds back any
 * previously-saved underlay for that hash that isn't already present in the
 * live (workspace-scoped) array, and never removes or clears anything. That
 * keeps a mid-session model switch's existing "preserved" behaviour exactly
 * as `markupTransitionPatch` already documents it, while still letting a
 * page reload (which loses all in-memory state) bring back what was loaded
 * against a given file.
 *
 * ## Empty vs. absent
 * `loadDxfUnderlaysEntry` returns `null` when there is nothing saved for a
 * hash (or the stored value is corrupt), and a real `{ dxfUnderlays: [],
 * savedAt }` when the user removed every underlay and that state was saved.
 * Callers must branch on this distinction, not on `dxfUnderlays.length` —
 * `mergeDxfUnderlays` itself only special-cases the empty saved-array case
 * as "nothing to add" (a no-op merge, same observable result either way),
 * but the load function's `null`-vs-`{ dxfUnderlays: [] }` return is what a
 * future consumer needing the distinction (e.g. a "clear this model's saved
 * underlays" affordance) would branch on.
 */

import { isDxfReferenceFrame } from '@/hooks/dxfReferencePlane';
import type { DxfPlacement, DxfUnderlay } from '@ifc-lite/drawing-2d';
import type { DxfUnderlayState } from './drawing2DSlice.js';

const DB_NAME = 'ifc-lite-drawing2d-dxf';
/**
 * Bump this when adding/removing/renaming object stores. Every new version
 * MUST extend the `onupgradeneeded` switch below with an idempotent
 * migration step from `event.oldVersion`, mirroring
 * `services/extensions/idb-storage.ts`'s convention.
 */
const DB_VERSION = 1;
const STORE_DXF = 'dxf-underlays';

/** Hard cap on distinct models remembered — oldest (by `savedAt`) evicted first, same policy as `drawing2DSlice.persistence.ts`'s `MAX_ENTRIES`. */
const MAX_ENTRIES = 20;

export interface PersistedDxfUnderlaysEntry {
  dxfUnderlays: DxfUnderlayState[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** `true` when `Storage.getItem`-style access to IndexedDB is even possible in this context (some private-browsing modes leave `indexedDB` undefined). */
function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Open (or recover) the database, or resolve `null` when IndexedDB is
 * unavailable or fails to open — callers degrade to "nothing
 * saved/restored" rather than throwing, matching
 * `drawing2DSlice.persistence.ts`'s try/catch-and-warn discipline for
 * `localStorage`.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (!hasIndexedDb()) return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[drawing2D] failed to open dxfUnderlays database', err);
      dbPromise = null;
      resolve(null);
      return;
    }
    request.onerror = () => {
      // eslint-disable-next-line no-console
      console.warn('[drawing2D] failed to open dxfUnderlays database', request.error);
      dbPromise = null;
      resolve(null);
    };
    request.onupgradeneeded = (event) => {
      const db = request.result;
      switch (event.oldVersion) {
        case 0:
          db.createObjectStore(STORE_DXF);
          break;
        default:
          // No-op until a v2+ migration exists — see idb-storage.ts's
          // identical convention for why this stays an explicit switch.
          break;
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DXF)) {
        // Recovery: delete and recreate, mirroring idb-storage.ts.
        db.close();
        dbPromise = null;
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = () => { openDatabase().then(resolve); };
        del.onerror = () => {
          // eslint-disable-next-line no-console
          console.warn('[drawing2D] failed to recreate dxfUnderlays database');
          resolve(null);
        };
        del.onblocked = () => {
          // eslint-disable-next-line no-console
          console.warn('[drawing2D] dxfUnderlays database recreation blocked by another open tab');
          resolve(null);
        };
        return;
      }
      resolve(db);
    };
  });
  return dbPromise;
}

function runStore<T = unknown>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_DXF, mode);
    const store = tx.objectStore(STORE_DXF);
    let value: unknown;
    const req = fn(store);
    if (req instanceof IDBRequest) {
      req.onsuccess = () => { value = req.result; };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(value as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ── Validation ───────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRecordOfBooleans(v: unknown): v is Record<string, boolean> {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'boolean');
}

function isDxfPlacementLike(v: unknown): v is DxfPlacement {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    isFiniteNumber(p.offsetX) &&
    isFiniteNumber(p.offsetY) &&
    isFiniteNumber(p.rotationDeg) &&
    isFiniteNumber(p.scale) && p.scale > 0
  );
}

/**
 * Loose structural check on a persisted `DxfUnderlay` — enough to catch
 * corruption without hand-validating every path/fill/text point, mirroring
 * `drawing2DSlice.persistence.ts`'s `isSectionConfigLike` for the same
 * reason: a failed check here drops the whole `DxfUnderlayState` entry
 * (below), it never throws.
 */
function isDxfUnderlayLike(v: unknown): v is DxfUnderlay {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.name === 'string' &&
    Array.isArray(u.layers) &&
    !!u.bounds && typeof u.bounds === 'object' &&
    isFiniteNumber(u.unitScale) &&
    !!u.skipped && typeof u.skipped === 'object' &&
    Array.isArray(u.warnings)
  );
}

function isDxfUnderlayState(v: unknown): v is DxfUnderlayState {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.id === 'string' && u.id.length > 0 &&
    typeof u.name === 'string' &&
    isDxfUnderlayLike(u.underlay) &&
    typeof u.visible === 'boolean' &&
    typeof u.visible3D === 'boolean' &&
    isFiniteNumber(u.opacity) && u.opacity >= 0 && u.opacity <= 1 &&
    isRecordOfBooleans(u.layerVisibility) &&
    isDxfPlacementLike(u.placement) &&
    (u.georeferenced === undefined || typeof u.georeferenced === 'boolean') &&
    (u.referenceFrame === undefined || isDxfReferenceFrame(u.referenceFrame))
  );
}

function isValidStoredEntry(v: unknown): v is PersistedDxfUnderlaysEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return isFiniteNumber(e.savedAt) && Array.isArray(e.dxfUnderlays);
}

// ── Storage I/O ──────────────────────────────────────────────────────

/**
 * Load the persisted `dxfUnderlays` for one model's content-hash key.
 * Returns `null` for "nothing saved for this hash" (a brand-new file, or a
 * hash resolved before this feature shipped) AND for a stored value so
 * corrupt it cannot be trusted at all — both degrade identically for a
 * caller deciding whether there is anything to merge in. A stored value
 * that parses but contains malformed individual entries drops only those
 * entries (`.filter(isDxfUnderlayState)`), matching
 * `drawing2DSlice.persistence.ts`'s per-entry validation discipline.
 */
export async function loadDxfUnderlaysEntry(modelHash: string): Promise<PersistedDxfUnderlaysEntry | null> {
  try {
    const db = await openDatabase();
    if (!db) return null;
    const raw = await runStore<unknown>(db, 'readonly', (store) => store.get(modelHash));
    if (raw === undefined) return null;
    if (!isValidStoredEntry(raw)) {
      // eslint-disable-next-line no-console
      console.warn(`[drawing2D] skipping malformed dxfUnderlays entry for model ${modelHash}`);
      return null;
    }
    return {
      dxfUnderlays: raw.dxfUnderlays.filter(isDxfUnderlayState),
      savedAt: raw.savedAt,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to read dxfUnderlays for model ${modelHash}`, err);
    return null;
  }
}

/**
 * Save `dxfUnderlays` (the full array, an explicit `[]` included) for one
 * model's content-hash key, then evict the oldest entries past
 * {@link MAX_ENTRIES} across ALL owned keys, same LRU policy as
 * `drawing2DSlice.persistence.ts`'s `saveDrawing2DEntry`. Swallows and warns
 * on any failure (quota, blocked upgrade, unavailable storage) rather than
 * throwing — a caller that awaits this never needs a try/catch of its own.
 */
export async function saveDxfUnderlaysEntry(modelHash: string, dxfUnderlays: DxfUnderlayState[]): Promise<void> {
  try {
    const db = await openDatabase();
    if (!db) return;
    const entry: PersistedDxfUnderlaysEntry = { dxfUnderlays, savedAt: Date.now() };
    // One readwrite transaction makes put+census+eviction atomic and lets
    // IndexedDB serialize the policy across tabs. A separate readonly census
    // could go stale before its delete transaction starts.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DXF, 'readwrite');
      const store = tx.objectStore(STORE_DXF);
      store.put(entry, modelHash);
      const owned: Array<{ key: IDBValidKey; savedAt: number }> = [];
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const value = cursor.value as unknown;
          if (isValidStoredEntry(value)) {
            owned.push({ key: cursor.primaryKey, savedAt: value.savedAt });
          }
          cursor.continue();
          return;
        }
        const toEvict = owned
          .sort((a, b) => a.savedAt - b.savedAt)
          .slice(0, Math.max(0, owned.length - MAX_ENTRIES));
        for (const { key } of toEvict) store.delete(key);
      };
      cursorRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? cursorRequest.error);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to persist dxfUnderlays for model ${modelHash}`, err);
  }
}

/**
 * Additive merge for the restore side: adds back any `saved` underlay whose
 * `id` is not already present in `existing`, and never removes or replaces
 * one already there. Returns `existing` BY REFERENCE (no new array, no
 * store update, no re-triggered save) when there is nothing to add — an
 * explicit empty `saved` array included — so a caller wiring this into a
 * `setState` can skip the call entirely on a no-op merge.
 *
 * This is deliberately NOT a replace: `dxfUnderlays` is classified
 * `'preserved'` by `drawing2DSlice.markupTransition.ts` (a workspace-wide
 * field, unlike the five per-model `'committed'` markup fields), so
 * restoring it must never clobber whatever the live session already has
 * loaded for a DIFFERENT model — see this module's doc.
 */
export function mergeDxfUnderlays(
  existing: DxfUnderlayState[],
  saved: DxfUnderlayState[],
): DxfUnderlayState[] {
  if (saved.length === 0) return existing;
  const existingIds = new Set(existing.map((u) => u.id));
  const toAdd = saved.filter((u) => {
    if (existingIds.has(u.id)) return false;
    existingIds.add(u.id);
    return true;
  });
  if (toAdd.length === 0) return existing;
  return [...existing, ...toAdd];
}
