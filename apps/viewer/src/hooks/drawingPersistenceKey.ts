/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The key 2D-drawing persistence is scoped by (#7035): the load's placement
 * identity (`FederatedModel.sourceContentHash`), which the loader computes in
 * its one full-source pass. Markup, sheets and DXF underlays used to be keyed
 * by a separate whole-file SHA-256, which cost every primary load a second
 * pass over the file.
 *
 * An identity is `placement-sha256-1m-v1:<64 hex>`; a key written before this
 * change is a bare `<64 hex>`. The two shapes cannot collide, and the bare
 * shape is how an entry that still needs moving is recognised without hashing
 * anything. The move itself lives in `drawingLegacyKeyMigration.ts`, imported
 * only when such an entry exists. This module is part of the viewer's eager
 * bundle, so it hands that one what it needs instead of being imported by it.
 *
 * The identity on a record belongs to the record's `sourceFile`: the loader
 * creates a record per load and writes the identity only while the record
 * still holds the file it hashed.
 */

import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { identifyLoadedPlacementSource } from '@/lib/model-placement/loaded-source-identity';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { keyFor } from '@/store/slices/drawing2DSlice.persistence.js';
import { sheetStorageKey } from '@/store/slices/sheetSlice.persistence';
import {
  loadDxfUnderlaysEntry,
  mergeDxfUnderlays,
  requestDxfUnderlayStore,
  saveDxfUnderlaysEntry,
} from '@/store/slices/drawing2DSlice.dxfPersistence.js';
import { hasUnsavedSheetEdit } from './sheetPersistence.js';
import { waitForPendingDxfUnderlaySave } from './dxfUnderlaySave.js';

const LEGACY_KEY = /^[0-9a-f]{64}$/;
/** `true` for a key written before #7035: a bare whole-file SHA-256. */
const isLegacyKey = (key: unknown): key is string => typeof key === 'string' && LEGACY_KEY.test(key);

/** The items of `older` that no item of `newer` replaces (same `id`), followed by `newer`. Returns `older` itself when `newer` is empty. */
export function unionById<T extends { id: string }>(older: T[], newer: T[]): T[] {
  if (newer.length === 0) return older;
  const ids = new Set(newer.map((item) => item.id));
  return [...older.filter((item) => !ids.has(item.id)), ...newer];
}

const loading = (model: FederatedModel) =>
  model.loadState === 'pending' || model.loadState === 'streaming-geometry' || model.loadState === 'hydrating-metadata';

/**
 * Resolves with the first defined `pick(model)` for the record that still
 * holds `file`, or with `null` once the record is gone or holds another file.
 */
function whenModel<T>(modelId: string, file: File, pick: (model: FederatedModel) => T | undefined): Promise<T | null> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const check = (): boolean => {
      const model = useViewerStore.getState().models.get(modelId);
      const value = model?.sourceFile === file ? pick(model) : null;
      if (value === undefined) return false;
      unsubscribe?.();
      resolve(value);
      return true;
    };
    if (!check()) unsubscribe = useViewerStore.subscribe(check);
  });
}

/** What the legacy-key move needs from the eager bundle. */
export interface LegacyMoveContext {
  modelId: string;
  file: File;
  /** Resolves `true` once the model has finished loading `file`, `false` if it was closed or replaced first. */
  loaded: () => Promise<boolean>;
  unionById: typeof unionById;
  /** The DXF underlay store and its save queue, which live in an eager chunk of their own. */
  dxf: {
    load: typeof loadDxfUnderlaysEntry;
    save: typeof saveDxfUnderlaysEntry;
    merge: typeof mergeDxfUnderlays;
    request: typeof requestDxfUnderlayStore;
    saved: typeof waitForPendingDxfUnderlaySave;
  };
}

const legacyMove = () => import('./drawingLegacyKeyMigration.js');
const moveContext = (modelId: string, file: File): LegacyMoveContext => ({
  modelId, file, unionById,
  dxf: { load: loadDxfUnderlaysEntry, save: saveDxfUnderlaysEntry, merge: mergeDxfUnderlays, request: requestDxfUnderlayStore, saved: waitForPendingDxfUnderlaySave },
  loaded: () => whenModel(modelId, file, (model) => (loading(model) ? undefined : true)).then((loaded) => loaded === true),
});

/**
 * The placement identity of `file` as loaded into `modelId`. The loader writes
 * it to the record while the load runs, so this normally hashes nothing. Two
 * cases have no identity on the record when asked. A model that finished
 * loading without one (a point cloud is identified after its scan is
 * finalized; a record created outside the loader never is) gets it from the
 * shared {@link identifyLoadedPlacementSource} pass. A load that was closed
 * first is hashed only if a sheet edit made during it still needs a key to be
 * saved under.
 */
async function identityOf(modelId: string, file: File): Promise<string | null> {
  const known = await whenModel(modelId, file, (model) => model.sourceContentHash ?? (loading(model) ? undefined : ''));
  if (known) return known;
  if (!globalThis.crypto?.subtle) return null; // no digest in this context, so nothing was ever keyed either
  if (known === null) return hasUnsavedSheetEdit(modelId, file) ? await placementSourceIdentity(file) ?? null : null;
  await identifyLoadedPlacementSource(modelId, file);
  const model = useViewerStore.getState().models.get(modelId);
  return model?.sourceFile === file ? model.sourceContentHash ?? null : null;
}

/** The localStorage keys of every markup or sheet entry still stored under a legacy key. */
function legacyLocalKeys(): string[] {
  const found: string[] = [];
  try {
    if (typeof localStorage === 'undefined') return found;
    const prefixes = [keyFor(''), sheetStorageKey('')];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix) && isLegacyKey(key.slice(prefix.length)))) found.push(key);
    }
  } catch (err) {
    // Storage that cannot be listed cannot be read for a restore either.
    console.warn('[drawing2D] cannot list saved entries', err);
  }
  return found;
}

/**
 * The key `modelId`'s drawing persistence reads and writes, or `null` when the
 * file has no identity. While markup or a sheet is still stored under some
 * legacy key, the restore stays pending until the move has run, so a saved
 * entry is found on the load that migrates it and still outranks IFC-embedded
 * markup.
 */
export async function resolveDrawingPersistenceKey(modelId: string, file: File): Promise<string | null> {
  const key = await identityOf(modelId, file);
  const legacy = key ? legacyLocalKeys() : [];
  if (key && legacy.length) {
    try {
      await (await legacyMove()).migrateLegacyLocalEntries(key, legacy, moveContext(modelId, file));
    } catch (err) {
      // The legacy entry is untouched; the next load moves it and merges it
      // with whatever this session saves under `key`.
      console.warn('[drawing2D] legacy markup not moved', err);
    }
  }
  return key;
}

/** After `key`'s restore has settled: move DXF underlays still stored under a legacy key. They merge additively, so they never hold the restore. */
export function migrateLegacyDxfUnderlays(key: string, modelId: string, file: File, stillCurrent: () => boolean): void {
  void requestDxfUnderlayStore('readonly', (store) => store.getAllKeys()).then(async (keys) => {
    const legacy = keys?.filter(isLegacyKey);
    if (legacy?.length) await (await legacyMove()).migrateLegacyDxfEntry(key, legacy, moveContext(modelId, file), stillCurrent);
  }).catch((err) => {
    console.warn('[drawing2D] legacy DXF underlays not moved', err);
  });
}
