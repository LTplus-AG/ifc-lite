/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surface-runoff screening state: the one check run per scene (started by a
 * click in the Georeference panel), its result for the checked model, and
 * whether the verdict colours are shown in the viewport.
 *
 * The result is kept as the `@ifc-lite/flood-check` package returns it, with
 * the property-set payloads `toPropertySets` derives from it. Nothing is
 * written into the model: the property panel shows the payloads beside the
 * element's own sets, labelled as a screening result.
 *
 * The run itself is `lib/flood-check/flood-check-run.ts`; this slice only
 * records it. As in the site-context slice, a run's identity is its abort
 * controller: it writes only while it is the current run.
 */

import type { StateCreator } from 'zustand';
import type { FloodCheckResult, FloodPropertySet } from '@ifc-lite/flood-check';
import { defineSliceTeardown } from '../teardown.js';

export interface FloodCheckOutcomeData {
  result: FloodCheckResult;
  /** `IfcLite_SurfaceRunoffExposure` per checked element, by model-local express id. */
  elementSets: Map<number, FloodPropertySet>;
  /** `IfcLite_SurfaceRunoffHazardSite`: the run's provenance, parameters and caveats. */
  siteSet: FloodPropertySet;
  /** Network requests and bytes this run sent (cache hits excluded). */
  requests: number;
  bytes: number;
  finishedAt: number;
}

export interface FloodCheckRun {
  modelId: string;
  status: 'running' | 'done' | 'error';
  /** Set while running; dropped when the run settles. */
  abort: AbortController | null;
  data: FloodCheckOutcomeData | null;
  /** The refusal or failure, with the package's refusal code when it refused. */
  error: { message: string; code: string | null } | null;
}

export interface FloodCheckSlice {
  floodCheck: FloodCheckRun | null;
  /** Verdict colours on the checked elements; on after every run. */
  floodColoursShown: boolean;

  beginFloodCheck: (modelId: string, abort: AbortController) => void;
  isFloodCheckRunCurrent: (run: AbortController) => boolean;
  finishFloodCheck: (run: AbortController, data: FloodCheckOutcomeData) => void;
  failFloodCheck: (run: AbortController, error: { message: string; code: string | null }) => void;
  /** User cancel or a run that saw its own abort: the run is forgotten, an earlier result is not restored. */
  cancelFloodCheck: () => void;
  clearFloodCheck: () => void;
  setFloodColoursShown: (shown: boolean) => void;
}

export const createFloodCheckSlice: StateCreator<FloodCheckSlice, [], [], FloodCheckSlice> = (set, get) => ({
  floodCheck: null,
  floodColoursShown: true,

  beginFloodCheck: (modelId, abort) => {
    get().floodCheck?.abort?.abort();
    set({ floodCheck: { modelId, status: 'running', abort, data: null, error: null } });
  },

  isFloodCheckRunCurrent: (run) => get().floodCheck?.abort === run,

  finishFloodCheck: (run, data) => set((state) => (state.floodCheck?.abort !== run ? {} : {
    floodCheck: { ...state.floodCheck, status: 'done', abort: null, data, error: null },
    floodColoursShown: true,
  })),

  failFloodCheck: (run, error) => set((state) => (state.floodCheck?.abort !== run ? {} : {
    floodCheck: { ...state.floodCheck, status: 'error', abort: null, data: null, error },
  })),

  cancelFloodCheck: () => {
    const run = get().floodCheck;
    if (run?.status !== 'running') return;
    run.abort?.abort();
    set({ floodCheck: null });
  },

  clearFloodCheck: () => {
    get().floodCheck?.abort?.abort();
    set({ floodCheck: null });
  },

  setFloodColoursShown: (shown) => set({ floodColoursShown: shown }),
});

/**
 * The result belongs to its model: removing that model (or every model, or
 * the session) drops it, which also takes the verdict colours down. The abort
 * handle is dropped, not called (a teardown is pure); a run that is no longer
 * current discards its own result.
 */
export const floodCheckTeardown = defineSliceTeardown(
  'floodCheckSlice',
  ['floodCheck', 'floodColoursShown'],
  {
    'session-reset': () => ({ floodCheck: null, floodColoursShown: true }),
    'model-removed': (scope, state) => (state.floodCheck?.modelId === scope.modelId ? { floodCheck: null } : {}),
    'all-models-cleared': () => ({ floodCheck: null }),
  },
);
