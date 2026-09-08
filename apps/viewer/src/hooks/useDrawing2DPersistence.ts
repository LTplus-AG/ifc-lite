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
 * A primary reload calls `resetViewerState()`, which wipes `measure2DResults`
 * etc. to `[]` and `activeModelId` to `null` in ONE atomic `set()` (see
 * `store/index.ts`), BEFORE the next model has loaded or its hash resolved.
 * The store's raw `subscribe` listener fires synchronously inside that same
 * `set()` call — synchronously with respect to the reset, not the (async,
 * React-effect-driven) hash resolution for whatever model loads next. If the
 * save path read its scoping key from a variable the restore effect owns, it
 * would still be pointing at the OLD model's hash at that instant and would
 * persist the wipe — overwriting the old model's saved markup with an empty
 * entry. Deriving the hash from `state.activeModelId` (already `null` in
 * that same atomic patch) instead makes the skip automatic and correct: no
 * hash, no save.
 */

import { useEffect, useRef } from 'react';
import type { SectionConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { computeSourceFingerprintFromBlob } from './sourceFingerprint.js';
import { loadDrawing2DEntry, saveDrawing2DEntry } from '@/store/slices/drawing2DSlice.persistence.js';

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
