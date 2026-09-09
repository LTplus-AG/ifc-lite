/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Restore-on-load for "save 2D drawing markup into the IFC model" (#4153):
 * when a model is parsed, populate `Drawing2DState`'s markup arrays from any
 * `DRAWING_MARKUP_OBJECTTYPE`-tagged `IfcAnnotation` entities it contains.
 *
 * ## The double-restore question (PR #4159's own localStorage restore)
 * #4159 (`useDrawing2DPersistence.ts`, `drawing2DSlice.persistence.ts`)
 * restores the SAME flat `measure2DResults`/`polygonArea2DResults`/
 * `textAnnotations2D`/`cloudAnnotations2D` fields from `localStorage`, keyed
 * by the loaded file's content hash. A model that is BOTH (a) the exact
 * bytes of a file the browser has a saved localStorage entry for, AND (b)
 * itself carries embedded markup annotations (only possible by re-opening a
 * file this feature previously saved into and then not re-exporting) has
 * two candidate sources for the same four arrays.
 *
 * An earlier version of this module resolved that with "never overwrite":
 * whichever source populated the (checked-empty) fields first wins. That
 * was wrong in two ways, not just undocumented. First, it was asymmetric in
 * fact, not just in the doc: `useDrawing2DPersistence`'s `applyHash` has
 * never had an emptiness check, so an IFC restore that happened to finish
 * first got silently clobbered the instant the localStorage hash resolved
 * — the exact opposite of "first wins". Second, even a SYMMETRIC emptiness
 * guard on both sides would still be a race: which restore's async work
 * resolves first depends on incidental timing (a hash computation vs. a
 * WASM parse), so the SAME code, same inputs, can pick either source
 * depending on nothing meaningful. And an emptiness check specifically
 * cannot even ask the right question — it cannot distinguish "no source
 * has restored yet" from "the authoritative source restored and correctly
 * produced an empty result" (e.g. the user deleted all their local markup
 * and that was saved).
 *
 * The rule this module now enforces: LOCALSTORAGE IS AUTHORITATIVE,
 * EXPLICITLY, NOT BY TIMING. A `localStorage` entry for this exact
 * full-content hash can only exist because a session in this browser
 * already had these exact bytes open — whatever that session drew (or
 * deleted) is therefore never staler than whatever is embedded in the file,
 * only possibly newer. `tryRestoreDrawingMarkup` below calls
 * `useDrawing2DPersistence.ts`'s `hasPersistedMarkupEntryFor` before ever
 * restoring the IFC's embedded markup: if that reports `'pending'` (the
 * hash hasn't resolved yet), this module WAITS, via
 * `onLocalStorageDecidedFor`, rather than racing it; if it reports `true`
 * (a saved entry exists, empty or not), this restore backs off for good;
 * only `false` (no entry — never saved for this file, or `localStorage`
 * unavailable) lets the IFC-embedded markup through. The outcome is now a
 * pure function of "does a localStorage entry exist", never of which
 * promise happened to settle first.
 *
 * `restoredForModel` additionally makes each model's restore attempt
 * run-once-until-emptied: a model this session already attempted (whether
 * it found markup or not) is not retried on every parse-cache notification
 * or remount, so drawing on a blank model and then having a LATER parse-cache
 * tick (e.g. a federated sibling model finishing its own parse) never
 * suddenly injects the model's embedded markup over what the user just drew.
 */

import { useEffect } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { restoreDrawingMarkupFromModel } from '@/lib/drawing2d-markup/drawing-markup-restore';
import { ensureParseFor, subscribeToParseCache } from './symbolic-parse-cache.js';
import { hasPersistedMarkupEntryFor, onLocalStorageDecidedFor } from './useDrawing2DPersistence.js';

/** Models this session has already attempted a restore for — see the module doc. */
const restoredForModel = new Set<string>();

/** Models currently waiting on #4159's localStorage precedence decision — see `tryRestoreDrawingMarkup`. Prevents piling up a redundant `onLocalStorageDecidedFor` listener per parse-cache notification while still pending. */
const awaitingLocalStorageDecision = new Set<string>();

function markupFieldsEmpty(): boolean {
  const s = useViewerStore.getState();
  return (
    s.measure2DResults.length === 0 &&
    s.polygonArea2DResults.length === 0 &&
    s.textAnnotations2D.length === 0 &&
    s.cloudAnnotations2D.length === 0
  );
}

/**
 * Attempt to restore `modelId`'s embedded markup. Safe to call repeatedly —
 * a no-op once this model has been attempted, once another source has
 * populated the fields, or once the model is no longer the active one.
 * Exported (rather than kept as a hook-internal closure) so tests can call
 * it bare, without mounting the hook through React — the flat-field
 * overwrite this guards against is exactly the kind of synchronous-store
 * race `act()` batching would mask.
 */
export function tryRestoreDrawingMarkup(modelId: string): void {
  if (restoredForModel.has(modelId)) return;
  if (useViewerStore.getState().activeModelId !== modelId) return;
  if (!markupFieldsEmpty()) {
    // Something else (a user drawing) already populated this model's
    // fields — never overwrite it.
    restoredForModel.add(modelId);
    return;
  }

  // Explicit precedence over #4159's localStorage restore (see module
  // doc): never guess from array emptiness alone, ask whether a saved
  // entry exists for this exact file.
  const persisted = hasPersistedMarkupEntryFor(modelId);
  if (persisted === 'pending') {
    if (!awaitingLocalStorageDecision.has(modelId)) {
      awaitingLocalStorageDecision.add(modelId);
      onLocalStorageDecidedFor(modelId, () => {
        awaitingLocalStorageDecision.delete(modelId);
        tryRestoreDrawingMarkup(modelId);
      });
    }
    return;
  }
  if (persisted) {
    // A localStorage entry exists (empty or not) for this exact file —
    // it always wins over the IFC's embedded markup. Back off for good.
    restoredForModel.add(modelId);
    return;
  }

  const result = restoreDrawingMarkupFromModel(modelId);
  if (!result) return; // not parsed yet — retry on the next parse-cache notification

  restoredForModel.add(modelId);
  const total =
    result.measure2DResults.length +
    result.polygonArea2DResults.length +
    result.textAnnotations2D.length +
    result.cloudAnnotations2D.length;
  if (total === 0) return;

  // Re-check immediately before writing: resolving `result` above is
  // synchronous, but another subscriber to the SAME store notification that
  // triggered this call may have already run its own write.
  if (!markupFieldsEmpty() || useViewerStore.getState().activeModelId !== modelId) return;

  useViewerStore.setState({
    measure2DResults: result.measure2DResults,
    polygonArea2DResults: result.polygonArea2DResults,
    textAnnotations2D: result.textAnnotations2D,
    cloudAnnotations2D: result.cloudAnnotations2D,
  });
}

/** @internal test-only reset of the module-level restore-attempt tracking. */
export function __resetDrawingMarkupRestoreForTests(): void {
  restoredForModel.clear();
  awaitingLocalStorageDecision.clear();
}

/**
 * Mount once, unconditionally, near the top of `Section2DPanel.tsx` — same
 * placement convention #4159's `useDrawing2DPersistence` documents for
 * itself, so restore runs as soon as a model loads even if the 2D panel is
 * closed.
 */
export function useDrawingMarkupRestoreOnLoad(): void {
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const dataStore = useViewerStore((s): IfcDataStore | undefined => {
    if (!s.activeModelId) return undefined;
    return s.models.get(s.activeModelId)?.ifcDataStore ?? (s.activeModelId === 'legacy' ? s.ifcDataStore ?? undefined : undefined);
  });

  useEffect(() => {
    if (!activeModelId || !dataStore) return;
    tryRestoreDrawingMarkup(activeModelId);
    ensureParseFor([dataStore]);
    return subscribeToParseCache(() => tryRestoreDrawingMarkup(activeModelId));
  }, [activeModelId, dataStore]);
}
