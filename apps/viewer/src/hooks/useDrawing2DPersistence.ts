/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wires `drawing2DSlice.persistence.ts` up to the live store (issue #4153).
 *
 * `drawing2DSlice.ts` is at its module-size budget, and the scoping key this
 * needs — a model content hash — is not known at slice-init time (no model
 * is loaded yet when the store is constructed) nor is it a field on
 * `FederatedModel` (adding one would grow `store/types.ts`, also at budget).
 * So this lives as an external bridge instead of slice actions: a React hook
 * that resolves the active model's content hash and restores its markup, plus
 * a raw store subscription that saves on every change to the persisted
 * fields — mirroring "call from the slice initializer and on each mutating
 * action" without adding either to the slice itself.
 *
 * Mount once, unconditionally (`useDrawing2DPersistence()` near the top of
 * `Section2DPanel.tsx`, before its `if (!panelVisible) return null`) so
 * restore runs as soon as a model loads even if the 2D panel is closed.
 *
 * ## Why the save path derives the hash SYNCHRONOUSLY from `hashCache`
 * rather than from a variable the restore effect maintains
 * A primary reload calls `resetViewerState()`, then `clearAllModels()`,
 * which together wipe `measure2DResults` etc. to `[]` and `activeModelId` to
 * `null` — BEFORE the next model has loaded or its hash resolved. The
 * store's raw `subscribe` listener fires synchronously inside those `set()`
 * calls — synchronously with respect to the reset, not the (async,
 * React-effect-driven) hash resolution for whatever model loads next. If the
 * save path read its scoping key from a variable the restore effect owns, it
 * would still be pointing at the OLD model's hash at that instant and would
 * persist the wipe — overwriting the old model's saved markup with an empty
 * entry. Deriving the hash from `state.activeModelId` instead makes the skip
 * automatic and correct: no hash, no save.
 *
 * That guard only WORKS because `modelSlice.teardown.ts`'s 'session-reset'
 * contribution nulls `activeModelId` in the SAME atomic patch that wipes the
 * markup fields (#4159 fix — it used to be `notApplicable`, leaving
 * `activeModelId` pointing at the OUTGOING model through that patch, so this
 * exact subscription read a "still-active" model whose markup had just been
 * wiped and persisted the wipe over its saved entry). This module has no way
 * to enforce that from the outside; it can only document the dependency.
 * `modelSlice.teardown.ts`'s own comment explains why nulling it there is
 * safe — every production call site pairs `resetViewerState()` with an
 * immediate `clearAllModels()` that already nulls it a moment later.
 *
 * ## Cross-model leak on an ordinary model switch (#4159 Bug 2)
 * `measure2DResults` and friends are flat, federation-wide store fields, not
 * scoped per model. Left alone, switching from model A to model B via
 * `setActiveModel()` leaves A's markup sitting in the store as B becomes
 * active: readable on B's canvas, and — since the save subscription above
 * keys purely off `activeModelId` — persistable into B's saved entry by any
 * change at all (drawing something, or `notifyDrawing2DSectionConfig` firing
 * from a 2D redraw) before B's own hash has even resolved.
 *
 * The PRIMARY fix is in `modelSlice.ts`'s `setActiveModel`: it now clears the
 * five persisted fields to {@link defaultMarkupPatch} in the SAME atomic
 * `set()` call that moves `activeModelId`, so no subscriber — this module's
 * save listener included — can ever observe "B is active" together with "the
 * fields still hold A's data". That is what closes the window completely;
 * doing it here, in a `useEffect`, would only narrow it (React effects run
 * after the store has already committed and after any other subscriber's
 * synchronous reaction to the same change). The clear this effect ALSO
 * performs below, before resolving B's hash, is a redundant second layer —
 * it protects state seeded directly via `useViewerStore.setState()` (tests,
 * or any future caller that bypasses the `setActiveModel` action) rather
 * than being the thing that makes the fix correct.
 *
 * ## The atomic clear's own leak: A → B → A destroys A's saved entry (#4159 Bug 4)
 * Closing Bug 2 by clearing the fields atomically WITH the id change created
 * a new failure: the save subscription above cannot tell "the fields were
 * just cleared because a switch is in progress" apart from "the user
 * genuinely cleared this model's markup" — both are "new id, default
 * fields" to a listener that only ever sees committed state. Switching A → B
 * → A when BOTH hashes are already in `hashCache` (both models visited
 * earlier this session) hits it: the A → B leg clears to defaults and (no
 * hash cached for B yet, or B not yet visited — usually a no-op) is
 * harmless; the B → A leg ALSO clears to defaults, but `hash(A)` IS cached,
 * so this listener fires with "A active, fields = defaults" and
 * synchronously overwrites A's real saved entry with an empty one — before
 * the restore effect below has restored anything. The restore effect then
 * reads back exactly what this listener just destroyed.
 *
 * Fixed by having `setActiveModel` mark its own accompanying clear via
 * `suppressNextSaveFor(modelId)`, in the SAME atomic patch, and this
 * listener consuming that mark instead of persisting. The mark is consumed
 * (not merely checked), so it covers only that one notification — a real
 * change to the same model right after still saves normally — and it is
 * keyed by model id, not a single flag, so an A → B switch cannot consume
 * the mark meant for a later B → A switch.
 */

import { useEffect, useRef } from 'react';
import type { SectionConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { computeSourceFingerprintFromBlob } from './sourceFingerprint.js';
import {
  loadDrawing2DEntry,
  saveDrawing2DEntry,
  defaultMarkupPatch,
  consumeSuppressedSave,
  suppressNextSaveFor,
} from '@/store/slices/drawing2DSlice.persistence.js';

/** modelId -> resolved content hash, or `null` when one could not be computed (no `sourceFile`). */
const hashCache = new Map<string, string | null>();

/**
 * The `SectionConfig` that produced the drawing currently on screen, if any.
 * Not store state — `drawing2D`/its inputs are deliberately not reactive
 * fields consumers subscribe to here, only a value this module remembers so
 * it can be folded into the next save. Reset alongside the rest of the
 * markup by the `activeModelId` effect below.
 */
let lastSectionConfig: SectionConfig | null = null;

/** The model whose hash `lastSectionConfig` belongs to, so a stale config from a just-replaced model never leaks into the next model's save. */
let lastSectionConfigModelId: string | null = null;

/**
 * Call after a 2D drawing is (re)generated so its `SectionConfig` is folded
 * into the next save for the CURRENTLY active model. A no-op call from a
 * generation that finished after the model changed (`modelId` stale) is
 * ignored rather than misattributed.
 */
export function notifyDrawing2DSectionConfig(modelId: string, config: SectionConfig | null): void {
  if (useViewerStore.getState().activeModelId !== modelId) return;
  lastSectionConfig = config;
  lastSectionConfigModelId = modelId;
  persistFor(modelId);
}

function currentHashFor(modelId: string | null): string | null | undefined {
  if (!modelId) return undefined;
  return hashCache.get(modelId);
}

function persistFor(modelId: string): void {
  const hash = currentHashFor(modelId);
  if (!hash) return;
  const s = useViewerStore.getState();
  saveDrawing2DEntry(hash, {
    measure2DResults: s.measure2DResults,
    polygonArea2DResults: s.polygonArea2DResults,
    textAnnotations2D: s.textAnnotations2D,
    cloudAnnotations2D: s.cloudAnnotations2D,
    drawing2DDisplayOptions: s.drawing2DDisplayOptions,
    sectionConfig: lastSectionConfigModelId === modelId ? lastSectionConfig : null,
  });
}

/** Registers the raw store subscription that saves on every persisted-field change. Idempotent — module-level, subscribed once regardless of how many components mount the hook. */
let saveSubscriptionStarted = false;
function ensureSaveSubscription(): void {
  if (saveSubscriptionStarted) return;
  saveSubscriptionStarted = true;
  let prev = useViewerStore.getState();
  useViewerStore.subscribe((state) => {
    const modelId = state.activeModelId;
    const changed =
      state.measure2DResults !== prev.measure2DResults ||
      state.polygonArea2DResults !== prev.polygonArea2DResults ||
      state.textAnnotations2D !== prev.textAnnotations2D ||
      state.cloudAnnotations2D !== prev.cloudAnnotations2D ||
      state.drawing2DDisplayOptions !== prev.drawing2DDisplayOptions;
    prev = state;
    if (!changed || !modelId) return;
    // #4159 Bug 4: `setActiveModel`'s atomic patch clears these fields to
    // defaults in the SAME `set()` that moves `activeModelId` — this
    // listener fires synchronously inside that call, before the restore
    // effect below has run, and cannot otherwise tell that accompanying
    // clear apart from the user genuinely clearing the new model's own
    // markup. `suppressNextSaveFor` marks exactly that one notification;
    // consuming it here (rather than checking-without-consuming) means any
    // later, real change to the same model still saves normally.
    if (consumeSuppressedSave(modelId)) return;
    persistFor(modelId);
  });
}

/**
 * Resolves the active model's content hash (from `FederatedModel.sourceFile`,
 * the same window-sampled fingerprint `services/ifc-cache.ts` keys its cache
 * on) and restores that model's persisted markup into the store. Restores
 * defaults (i.e. does nothing — the fields are already `[]`/defaults after
 * `resetViewerState`) when nothing is saved for the hash, or when a hash
 * cannot be computed at all (no `sourceFile` — e.g. a cache-restored model),
 * which degrades to today's non-persisted behaviour for that load rather
 * than throwing.
 */
export function useDrawing2DPersistence(): void {
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const tokenRef = useRef(0);

  useEffect(() => { ensureSaveSubscription(); }, []);

  useEffect(() => {
    const token = ++tokenRef.current;
    const stillCurrent = () => tokenRef.current === token && useViewerStore.getState().activeModelId === activeModelId;

    if (!activeModelId) {
      lastSectionConfig = null;
      lastSectionConfigModelId = null;
      return;
    }

    // Bug 2 fix (#4159): clear the flat, federation-wide markup fields to
    // defaults THE MOMENT this model becomes active — before the async hash
    // lookup below, and before any saved entry for it is restored. Without
    // this, whatever the PREVIOUS active model left in these fields stays
    // live (and savable) under the new model's identity until the restore
    // below happens to overwrite it, which it may never do (a brand-new
    // file with nothing saved leaves the stale fields untouched forever).
    //
    // This `setState` is its own atomic patch, separate from
    // `setActiveModel`'s — `modelSlice.ts` already suppressed ITS
    // accompanying clear, but that mark is consumed the instant the save
    // subscription sees it (synchronously, inside `setActiveModel`'s own
    // `set()`, before this scheduled effect even runs). Left unmarked, THIS
    // clear would repeat #4159 Bug 4 on its own: an already-cached model
    // would have its real entry overwritten with empty data by this exact
    // call. Mark it again, immediately before the call that fires it.
    lastSectionConfig = null;
    lastSectionConfigModelId = null;
    suppressNextSaveFor(activeModelId);
    useViewerStore.setState(defaultMarkupPatch());

    const applyHash = (hash: string | null) => {
      if (!stillCurrent()) return;
      lastSectionConfig = null;
      lastSectionConfigModelId = null;
      if (!hash) return;

      const defaults = getDefaultDrawing2DState().drawing2DDisplayOptions;
      const entry = loadDrawing2DEntry(hash, defaults);
      if (!entry) return;

      lastSectionConfig = entry.sectionConfig;
      lastSectionConfigModelId = activeModelId;
      useViewerStore.setState({
        measure2DResults: entry.measure2DResults,
        polygonArea2DResults: entry.polygonArea2DResults,
        textAnnotations2D: entry.textAnnotations2D,
        cloudAnnotations2D: entry.cloudAnnotations2D,
        drawing2DDisplayOptions: entry.drawing2DDisplayOptions,
      });
    };

    const cached = hashCache.get(activeModelId);
    if (cached !== undefined) {
      applyHash(cached);
      return;
    }

    const model = useViewerStore.getState().models.get(activeModelId);
    const sourceFile = model?.sourceFile;
    if (!sourceFile) {
      hashCache.set(activeModelId, null);
      applyHash(null);
      return;
    }

    computeSourceFingerprintFromBlob(sourceFile)
      .then((fp) => {
        hashCache.set(activeModelId, fp.hex);
        applyHash(fp.hex);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[drawing2D] failed to fingerprint model for markup restore', err);
        hashCache.set(activeModelId, null);
        applyHash(null);
      });
  }, [activeModelId]);
}
