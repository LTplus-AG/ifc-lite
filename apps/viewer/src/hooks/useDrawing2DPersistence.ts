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
 * So this lives as an external bridge instead of slice actions: this React
 * hook resolves the active model's content hash and restores its markup;
 * `drawingMarkupSave.ts` (split out at the same time, module-size budget)
 * owns the raw store subscription that saves on every change to the
 * persisted fields — mirroring "call from the slice initializer and on each
 * mutating action" without adding either to the slice itself. See that
 * module's doc for the save path's own two-bug history (#4159 Bug 2, Bug 4)
 * and why it derives its scoping hash synchronously rather than from a
 * variable this hook owns.
 *
 * Mount once, unconditionally (`useDrawing2DPersistence()` near the top of
 * `Section2DPanel.tsx`, before its `if (!panelVisible) return null`) so
 * restore runs as soon as a model loads even if the 2D panel is closed.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash.js';
import { loadDrawing2DEntry, defaultMarkupPatch, suppressNextSaveFor } from '@/store/slices/drawing2DSlice.persistence.js';
import { getCachedHash, setCachedHash, notifyDecided } from './drawingMarkupRestorePrecedence.js';
import { resetSaveState, beginRestore, endRestore, setRestoredSectionConfig, ensureSaveSubscription } from './drawingMarkupSave.js';

export { hasPersistedMarkupEntryFor, onLocalStorageDecidedFor } from './drawingMarkupRestorePrecedence.js';
export { notifyDrawing2DSectionConfig, consumeRestoredSectionConfig } from './drawingMarkupSave.js';

/**
 * Resolves the active model's content hash (from `FederatedModel.sourceFile`)
 * and restores that model's persisted markup into the store. This is a TRUE
 * full-content SHA-256 (`computeFullSourceHashFromBlob`), NOT the
 * window-sampled fingerprint `services/ifc-cache.ts` keys its geometry cache
 * on: that sampler is a deliberately O(1) cache-lookup key with a proven
 * blind spot (an edit landing between its sample windows is invisible to
 * it — see `hooks/sourceFingerprint.ts`'s docs), safe there only because a
 * false key-hit is still gated by an mtime guard and this same full hash as
 * a background revalidation layer. Markup restore has no such second gate —
 * whatever this resolves to is used directly as the `localStorage` key — so
 * it must be an identity that cannot collide on two genuinely different
 * models, not merely a fast one. Restores defaults (i.e. does nothing — the
 * fields are already `[]`/defaults after `resetViewerState`) when nothing is
 * saved for the hash, or when a hash cannot be computed at all (no
 * `sourceFile` — e.g. a cache-restored model), which degrades to today's
 * non-persisted behaviour for that load rather than throwing.
 *
 * ## Precedence over #4170's IFC-embedded restore (`useDrawingMarkupRestoreOnLoad.ts`)
 * `applyHash` below writes unconditionally — no emptiness check — by
 * design: a `localStorage` entry, when one exists for this exact
 * full-content hash, is ALWAYS authoritative over whatever markup happens
 * to be embedded in the IFC bytes themselves, never merely "whichever
 * source got there first". Two reasons. First, the hash is the file's true
 * content — a `localStorage` entry keyed to it can only exist because a
 * session in THIS browser already had these exact bytes open; anything
 * that session then drew (or deleted) is necessarily at least as recent as
 * whatever was embedded in the file before that session started, so it is
 * never staler, only possibly newer. Second, and more important: a rule
 * that instead let "whichever restore's async work resolves first" decide
 * would make the SAME code produce different results across runs for the
 * SAME inputs, only because of incidental timing — a hash computation or a
 * WASM parse finishing a few milliseconds sooner or later. That is a race
 * even when neither outcome is technically "wrong" in isolation, and
 * `hasPersistedMarkupEntryFor`/`onLocalStorageDecidedFor` exist so the IFC
 * restore can wait for this decision instead of guessing from current
 * array contents (which can't tell "no source has run yet" apart from
 * "this source ran and correctly produced empty").
 */
export function useDrawing2DPersistence(): void {
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const tokenRef = useRef(0);

  useEffect(() => { ensureSaveSubscription(); }, []);

  useEffect(() => {
    const token = ++tokenRef.current;
    const stillCurrent = () => tokenRef.current === token && useViewerStore.getState().activeModelId === activeModelId;

    if (!activeModelId) {
      resetSaveState();
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
    // #4159 review (cross-model sectionConfig contamination): mark this
    // model as "restore in flight" for the SAME reason the clear above is
    // marked via `suppressNextSaveFor` — until `applyHash` runs below,
    // `notifyDrawing2DSectionConfig` cannot tell a legitimate save for THIS
    // model apart from a stray one carrying a config computed for whichever
    // model was active before it. Cleared inside `applyHash`, once this
    // model's restore has actually concluded.
    beginRestore(activeModelId);
    suppressNextSaveFor(activeModelId);
    useViewerStore.setState(defaultMarkupPatch());

    const applyHash = (hash: string | null) => {
      if (!stillCurrent()) return;
      endRestore(activeModelId);
      if (!hash) return;

      const defaults = getDefaultDrawing2DState().drawing2DDisplayOptions;
      const entry = loadDrawing2DEntry(hash, defaults);
      if (!entry) return;

      setRestoredSectionConfig(activeModelId, entry.sectionConfig);
      useViewerStore.setState({
        measure2DResults: entry.measure2DResults,
        polygonArea2DResults: entry.polygonArea2DResults,
        textAnnotations2D: entry.textAnnotations2D,
        cloudAnnotations2D: entry.cloudAnnotations2D,
        drawing2DDisplayOptions: entry.drawing2DDisplayOptions,
      });
    };

    const cached = getCachedHash(activeModelId);
    if (cached !== undefined) {
      applyHash(cached);
      // Symmetric with the branches below — a no-op today (this model's
      // listeners already fired on the earlier mount that cached its hash;
      // see `hasPersistedMarkupEntryFor`'s doc) but keeps "hashCache settling
      // fires decided listeners" true by construction, not just by that
      // function re-deriving its answer from `hashCache`.
      notifyDecided(activeModelId);
      return;
    }

    const model = useViewerStore.getState().models.get(activeModelId);
    const sourceFile = model?.sourceFile;
    if (!sourceFile) {
      setCachedHash(activeModelId, null);
      applyHash(null);
      notifyDecided(activeModelId);
      return;
    }

    computeFullSourceHashFromBlob(sourceFile)
      .then((hash) => {
        setCachedHash(activeModelId, hash);
        applyHash(hash);
        notifyDecided(activeModelId);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[drawing2D] failed to hash model for markup restore', err);
        setCachedHash(activeModelId, null);
        applyHash(null);
        notifyDecided(activeModelId);
      });
  }, [activeModelId]);
}
