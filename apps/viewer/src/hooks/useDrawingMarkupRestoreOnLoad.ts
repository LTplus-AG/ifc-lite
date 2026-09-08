/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Restore-on-load for "save 2D drawing markup into the IFC model" (#4153):
 * when a model is parsed, populate `Drawing2DState`'s markup arrays from any
 * `DRAWING_MARKUP_OBJECTTYPE`-tagged `IfcAnnotation` entities it contains.
 *
 * ## The double-restore question (PR #4159's own localStorage restore)
 * #4159 (a separate, in-flight branch this PR does not build on and does
 * not modify — see `useDrawing2DPersistence.ts`, `drawing2DSlice.persistence.ts`)
 * restores the SAME flat `measure2DResults`/`polygonArea2DResults`/
 * `textAnnotations2D`/`cloudAnnotations2D` fields from `localStorage`, keyed
 * by the loaded file's content hash. Once both land, a model that is BOTH
 * (a) the exact bytes of a file the browser has a saved localStorage entry
 * for, AND (b) itself carries embedded markup annotations (only possible by
 * re-opening a file this feature previously saved into and then not
 * re-exporting) would have two candidate sources for the same four arrays.
 *
 * The rule this module enforces: NEVER OVERWRITE. `tryRestoreDrawingMarkup`
 * only writes when all four arrays are still empty at the moment it is
 * about to write (checked once when it starts working, and AGAIN
 * immediately before the `setState`, since resolving the model's parsed
 * `ParseResult` can take a tick). Whichever source populates the fields
 * FIRST wins; the other finds non-empty arrays and backs off. Because both
 * this restore and #4159's `applyHash` write the four arrays as a single
 * full-array overwrite (never append/merge), "whichever wins" can only ever
 * produce ONE set of values on screen — duplication is structurally
 * impossible here, only which source's values show is a race. This module
 * cannot make that race deterministic without importing #4159's
 * still-being-restructured files, which the task explicitly excludes
 * touching; "never overwrite" is the defensible rule available without that.
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

/** Models this session has already attempted a restore for — see the module doc. */
const restoredForModel = new Set<string>();

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
    // Something else (a user drawing, or #4159's localStorage restore)
    // already populated this model's fields — never overwrite it.
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
