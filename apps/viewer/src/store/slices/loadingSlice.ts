/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading state slice
 */

import type { StateCreator } from 'zustand';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export interface LoadingSlice {
  // State
  loading: boolean;
  geometryStreamingActive: boolean;
  progress: { phase: string; percent: number; indeterminate?: boolean } | null;
  geometryProgress: { phase: string; percent: number; indeterminate?: boolean } | null;
  metadataProgress: { phase: string; percent: number; indeterminate?: boolean } | null;
  error: string | null;
  /**
   * Cancellation hook for an in-flight long-running operation (e.g.
   * streaming a 100M-point scan). UI components can show a Cancel
   * button while this is non-null. The loader hooks register the
   * canceller after starting the stream and clear it on success /
   * error. Kept on the loading slice (not its own slice) since it
   * tracks lifecycle alongside `progress`.
   */
  activeStreamCanceller: (() => void) | null;
  /**
   * Cancel for the active primary or federated model load (#5849), published by
   * `hooks/modelLoadCanceller.ts`. A slot of its own, NOT
   * `activeStreamCanceller`: GPU device-loss recovery cancels whatever is in
   * that slot (a scan must not publish a handle into a torn-down renderer),
   * and a model load must survive a device loss. UI reads either slot through
   * `selectLoadCanceller`.
   */
  activeLoadCanceller: (() => void) | null;
  /**
   * The file the most recently started load is reading (#5849), primary or
   * federated. The loading card names it; a federated add registers no model
   * record until it finalizes, so the models map cannot say which file it is.
   */
  loadingFileName: string | null;
  /**
   * #5175: set exactly when a LandXML load fails because the source declares
   * no `<Units>` (the LXML009 refusal). Lets a banner offer the user a
   * linear-unit choice and retry the same load with it — the ONLY UI path
   * that ever supplies `assumedLinearUnit`; nothing infers or preselects one.
   * `retry` closes over the original `File` and load target. Cleared at the
   * start of every `loadFile` call (same lifecycle as `error`), so a stale
   * prompt from a previous failed load never survives into the next one.
   */
  landXmlUnitsRefusal: { fileName: string; retry: (assumedLinearUnit: string) => void } | null;
  /**
   * Re-runs the load that most recently set `error` (#5851), same File,
   * URL, or buffers, through the same call. Set ONLY by
   * `lib/analytics.ts`'s `showLoadError`, alongside the message it sets —
   * never independently, and `setError` clears it whenever `error` is
   * cleared (see `setError` below), so a stale retry from a PREVIOUS,
   * unrelated failure can never survive to sit next to a new one. `null`
   * when nothing can usefully be retried; the card then renders without a
   * Retry button. The load-error card's Retry button is the one reader.
   */
  lastLoadRetry: (() => void) | null;

  // Actions
  setLoading: (loading: boolean) => void;
  setGeometryStreamingActive: (active: boolean) => void;
  setProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setGeometryProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setMetadataProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setError: (error: string | null) => void;
  setActiveStreamCanceller: (cancel: (() => void) | null) => void;
  setActiveLoadCanceller: (cancel: (() => void) | null) => void;
  setLoadingFileName: (fileName: string | null) => void;
  setLandXmlUnitsRefusal: (value: LoadingSlice['landXmlUnitsRefusal']) => void;
  setLastLoadRetry: (retry: (() => void) | null) => void;
}

export const createLoadingSlice: StateCreator<LoadingSlice, [], [], LoadingSlice> = (set) => ({
  // Initial state
  loading: false,
  geometryStreamingActive: false,
  progress: null,
  geometryProgress: null,
  metadataProgress: null,
  error: null,
  activeStreamCanceller: null,
  activeLoadCanceller: null,
  loadingFileName: null,
  landXmlUnitsRefusal: null,
  lastLoadRetry: null,

  // Actions
  setLoading: (loading) => set({ loading }),
  setGeometryStreamingActive: (geometryStreamingActive) => set({ geometryStreamingActive }),
  setProgress: (progress) => set({ progress }),
  setGeometryProgress: (geometryProgress) => set({ geometryProgress }),
  setMetadataProgress: (metadataProgress) => set({ metadataProgress }),
  // Clearing `error` always clears `lastLoadRetry` with it (#5851 review):
  // the only other writer of `lastLoadRetry` is `showLoadError`, which sets
  // both together, so this is the one place a stale retry could otherwise
  // survive its error and attach itself to whatever sets a new one next.
  setError: (error) => set(error === null ? { error, lastLoadRetry: null } : { error }),
  setActiveStreamCanceller: (activeStreamCanceller) => set({ activeStreamCanceller }),
  setActiveLoadCanceller: (activeLoadCanceller) => set({ activeLoadCanceller }),
  setLoadingFileName: (loadingFileName) => set({ loadingFileName }),
  setLandXmlUnitsRefusal: (landXmlUnitsRefusal) => set({ landXmlUnitsRefusal }),
  setLastLoadRetry: (lastLoadRetry) => set({ lastLoadRetry }),
});

/**
 * What a session reset clears on the loading slice.
 *
 * `resetViewerState`'s "Data" block owns these six today (`store/index.ts`):
 * a file swap ends whatever load was in flight as far as the UI is concerned,
 * so the spinner, the three progress channels and the last error all go.
 *
 * `error` is THIS slice's field, not `chatSlice`'s — that one is `chatError`.
 *
 * `activeStreamCanceller` and `activeLoadCanceller` are deliberately absent
 * from `owns`: no teardown path
 * resets it today. It is a live cancellation hook owned by the loader hook
 * that registered it, and dropping it here would silently orphan an in-flight
 * stream's only stop button.
 *
 * `landXmlUnitsRefusal` and `lastLoadRetry` follow `error`'s lifecycle: a
 * session reset ends whatever load prompted them, so the stale retry
 * closures (and the `File` they hold) go with it rather than outliving the
 * load they belong to.
 */
export const loadingTeardown = defineSliceTeardown(
  'loadingSlice',
  ['loading', 'geometryStreamingActive', 'progress', 'geometryProgress', 'metadataProgress', 'error', 'loadingFileName', 'landXmlUnitsRefusal', 'lastLoadRetry'],
  {
    'session-reset': () => ({
      loading: false,
      geometryStreamingActive: false,
      progress: null,
      geometryProgress: null,
      metadataProgress: null,
      error: null,
      loadingFileName: null,
      landXmlUnitsRefusal: null,
      lastLoadRetry: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);

type LoadProgressFields = Pick<LoadingSlice, 'progress' | 'geometryProgress' | 'metadataProgress'>;

/**
 * The one progress a load surface shows: geometry streaming, then metadata
 * hydration, then the generic load phase. Every progress UI (ribbon, classic
 * and mobile toolbars, the in-viewport loading card) reads this rather than
 * repeating the fallback chain (#5849).
 */
export function selectActiveLoadProgress(state: LoadProgressFields): LoadingSlice['progress'] {
  return state.geometryProgress ?? state.metadataProgress ?? state.progress;
}

/** The Cancel the load UI offers: the model load's, else a point-cloud stream's. */
export function selectLoadCanceller(state: Pick<LoadingSlice, 'activeLoadCanceller' | 'activeStreamCanceller'>): (() => void) | null {
  return state.activeLoadCanceller ?? state.activeStreamCanceller;
}
