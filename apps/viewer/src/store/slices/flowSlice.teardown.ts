/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineSliceTeardown } from '../teardown.js';

/**
 * Saved graphs and the working copy are workspace state and survive a
 * session reset; the panel flag and the last run (entity handles and outputs
 * of the OUTGOING model) do not. Removing one model drops the last run too:
 * its outputs hold handles into whichever model the graph read, and a run bar
 * showing counts over a model that is gone reads as a result nobody can
 * reproduce.
 *
 * `flowRunning` is NOT reset here (A2). It mirrors the execution lease
 * (`lib/flow/run-session.ts`), which a reset cannot end: the run is cancelled
 * through `analysisRunGeneration` and holds the lease until its
 * non-abortable work drains. Resetting the flag offered Run while the lease
 * was still held, so a click failed with "already running", and the drained
 * run then wrote its AbortError into the new session. The run clears the flag
 * itself when it settles (`useFlowRunner`).
 */
export const flowTeardown = defineSliceTeardown(
  'flowSlice',
  ['flowPanelVisible', 'flowLastRun', 'flowLastError', 'flowLastRunWindow', 'flowProgress', 'flowRunWarnings', 'flowArtifacts'],
  {
    'session-reset': () => ({ flowPanelVisible: false, flowLastRun: null, flowLastError: null, flowLastRunWindow: null, flowProgress: null, flowRunWarnings: [], flowArtifacts: [] }),
    'model-removed': () => ({ flowLastRun: null, flowLastError: null, flowLastRunWindow: null, flowProgress: null, flowRunWarnings: [], flowArtifacts: [] }),
    'all-models-cleared': () => ({ flowLastRun: null, flowLastError: null, flowLastRunWindow: null, flowProgress: null, flowRunWarnings: [], flowArtifacts: [] }),
  },
);
