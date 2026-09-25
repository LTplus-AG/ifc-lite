/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineSliceTeardown } from '../teardown.js';

/**
 * Saved graphs and the working copy are workspace state and survive a
 * session reset; the panel flag, the running flag and the last run
 * (entity handles and outputs of the OUTGOING model) do not. Removing one
 * model drops the last run too: its outputs hold handles into whichever
 * model the graph read, and a run bar showing counts over a model that is
 * gone reads as a result nobody can reproduce.
 */
export const flowTeardown = defineSliceTeardown(
  'flowSlice',
  ['flowPanelVisible', 'flowRunning', 'flowLastRun', 'flowLastError', 'flowLastRunWindow'],
  {
    'session-reset': () => ({ flowPanelVisible: false, flowRunning: false, flowLastRun: null, flowLastError: null, flowLastRunWindow: null }),
    'model-removed': () => ({ flowLastRun: null, flowLastError: null, flowLastRunWindow: null }),
    'all-models-cleared': () => ({ flowLastRun: null, flowLastError: null, flowLastRunWindow: null }),
  },
);
