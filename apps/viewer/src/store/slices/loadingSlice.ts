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
   * #5175: set exactly when a LandXML load fails because the source declares
   * no `<Units>` (the LXML009 refusal). Lets a banner offer the user a
   * linear-unit choice and retry the same load with it — the ONLY UI path
   * that ever supplies `assumedLinearUnit`; nothing infers or preselects one.
   * `retry` closes over the original `File` and load target. Cleared at the
   * start of every `loadFile` call (same lifecycle as `error`), so a stale
   * prompt from a previous failed load never survives into the next one.
   */
  landXmlUnitsRefusal: { fileName: string; retry: (assumedLinearUnit: string) => void } | null;

  // Actions
  setLoading: (loading: boolean) => void;
  setGeometryStreamingActive: (active: boolean) => void;
  setProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setGeometryProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setMetadataProgress: (progress: { phase: string; percent: number; indeterminate?: boolean } | null) => void;
  setError: (error: string | null) => void;
  setActiveStreamCanceller: (cancel: (() => void) | null) => void;
  setLandXmlUnitsRefusal: (value: LoadingSlice['landXmlUnitsRefusal']) => void;
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
  landXmlUnitsRefusal: null,

  // Actions
  setLoading: (loading) => set({ loading }),
  setGeometryStreamingActive: (geometryStreamingActive) => set({ geometryStreamingActive }),
  setProgress: (progress) => set({ progress }),
  setGeometryProgress: (geometryProgress) => set({ geometryProgress }),
  setMetadataProgress: (metadataProgress) => set({ metadataProgress }),
  setError: (error) => set({ error }),
  setActiveStreamCanceller: (activeStreamCanceller) => set({ activeStreamCanceller }),
  setLandXmlUnitsRefusal: (landXmlUnitsRefusal) => set({ landXmlUnitsRefusal }),
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
 * `activeStreamCanceller` is deliberately absent from `owns`: no teardown path
 * resets it today. It is a live cancellation hook owned by the loader hook
 * that registered it, and dropping it here would silently orphan an in-flight
 * stream's only stop button.
 *
 * `landXmlUnitsRefusal` follows `error`'s lifecycle: a session reset ends
 * whatever load prompted it, so the stale retry closure (and the `File` it
 * holds) goes with it rather than outliving the load it belongs to.
 */
export const loadingTeardown = defineSliceTeardown(
  'loadingSlice',
  ['loading', 'geometryStreamingActive', 'progress', 'geometryProgress', 'metadataProgress', 'error', 'landXmlUnitsRefusal'],
  {
    'session-reset': () => ({
      loading: false,
      geometryStreamingActive: false,
      progress: null,
      geometryProgress: null,
      metadataProgress: null,
      error: null,
      landXmlUnitsRefusal: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
