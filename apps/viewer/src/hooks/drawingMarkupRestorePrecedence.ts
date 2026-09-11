/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-module precedence protocol between `useDrawing2DPersistence.ts`
 * (#4159, localStorage-keyed-by-content-hash restore) and
 * `useDrawingMarkupRestoreOnLoad.ts` (#4170, IFC-embedded restore). Split out
 * of `useDrawing2DPersistence.ts` (module-size budget) rather than left
 * inline there, because this piece has its own, separate contract: it is the
 * only thing the OTHER hook depends on, and neither hook's own restore logic
 * touches it.
 *
 * `useDrawing2DPersistence.ts` resolves each active model's content hash
 * into {@link hashCache} (via {@link getCachedHash}/{@link setCachedHash})
 * and calls {@link notifyDecided} once that model's restore decision is
 * final. `useDrawingMarkupRestoreOnLoad.ts` asks {@link hasPersistedMarkupEntryFor}
 * before ever restoring a model's IFC-embedded markup — `'pending'` means
 * `useDrawing2DPersistence`'s hash for that model has not resolved yet, and
 * the caller should wait via {@link onLocalStorageDecidedFor} rather than
 * race it. See `useDrawingMarkupRestoreOnLoad.ts`'s own module doc for why a
 * plain "whichever source finishes first" race is wrong even when neither
 * outcome is individually incorrect.
 */

import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { loadDrawing2DEntry } from '@/store/slices/drawing2DSlice.persistence.js';

/** modelId -> resolved content hash, or `null` when one could not be computed (no `sourceFile`). */
const hashCache = new Map<string, string | null>();

/** Read `modelId`'s cached hash. `undefined` means no hash has been resolved (or attempted) for it yet. */
export function getCachedHash(modelId: string): string | null | undefined {
  return hashCache.get(modelId);
}

/** Record `modelId`'s resolved hash (or `null` when one could not be computed), and nothing else — callers still notify {@link notifyDecided} themselves once ready to. */
export function setCachedHash(modelId: string, hash: string | null): void {
  hashCache.set(modelId, hash);
}

/**
 * modelId -> callbacks waiting on this model's localStorage restore decision
 * to conclude. Backs {@link onLocalStorageDecidedFor}, the explicit-precedence
 * signal `useDrawingMarkupRestoreOnLoad.ts` (#4170) waits on before restoring
 * the SAME model's markup from the IFC — see that module's doc for why.
 */
const decidedListeners = new Map<string, Set<() => void>>();

/** Fire and forget every listener waiting on `modelId`'s restore decision (see {@link onLocalStorageDecidedFor}). */
export function notifyDecided(modelId: string): void {
  const listeners = decidedListeners.get(modelId);
  if (!listeners) return;
  decidedListeners.delete(modelId);
  for (const cb of listeners) cb();
}

/**
 * Whether `modelId`'s `localStorage` restore has concluded, and if so,
 * whether it found a saved entry. `'pending'` means `useDrawing2DPersistence`'s
 * `applyHash` has not run for this model yet (either the hash itself is still
 * resolving, or no `useDrawing2DPersistence()` consumer has even mounted for
 * it) — the caller should wait via {@link onLocalStorageDecidedFor} rather
 * than proceed. This is a query over `hashCache` (the resolved hash) plus a
 * fresh `loadDrawing2DEntry` read, not a stored decision, because
 * `loadDrawing2DEntry` is a pure `localStorage` read — cheap, and always
 * current even if called before `applyHash` itself has run for this exact
 * mount (e.g. a cached hash from an earlier visit this session).
 */
export function hasPersistedMarkupEntryFor(modelId: string): 'pending' | boolean {
  const hash = hashCache.get(modelId);
  if (hash === undefined) {
    // No `useDrawing2DPersistence()` consumer has resolved this model's
    // hash yet — but a model with no `sourceFile` at all (a cache-restored
    // model, or a deliberately partial stub several existing component
    // tests seed with no persistence hook mounted for it — see
    // `useDrawingMarkupRestoreOnLoad.test.ts`) can never produce one:
    // `applyHash`'s own `!sourceFile` branch answers `false` synchronously
    // for exactly this case. Mirror that here rather than waiting forever
    // on a hook that may never mount for this model.
    if (!useViewerStore.getState().models.get(modelId)?.sourceFile) return false;
    return 'pending';
  }
  if (!hash) return false;
  const defaults = getDefaultDrawing2DState().drawing2DDisplayOptions;
  return loadDrawing2DEntry(hash, defaults) !== null;
}

/**
 * Subscribe to be notified once `modelId`'s `localStorage` restore decision
 * is known (i.e. once {@link hasPersistedMarkupEntryFor} would stop
 * returning `'pending'`). One-shot: fires at most once, then forgets the
 * callback. Returns an unsubscribe function for a caller that stops
 * waiting first (e.g. the model changed again before the hash resolved).
 */
export function onLocalStorageDecidedFor(modelId: string, cb: () => void): () => void {
  let listeners = decidedListeners.get(modelId);
  if (!listeners) {
    listeners = new Set();
    decidedListeners.set(modelId, listeners);
  }
  listeners.add(cb);
  return () => listeners!.delete(cb);
}
