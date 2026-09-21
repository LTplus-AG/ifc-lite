/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * Saved graphs and the working copy are workspace state and survive a
 * session reset; the panel flag, the running flag and the last run
 * (entity handles and outputs of the OUTGOING model) do not.
 */
export const flowTeardown = defineSliceTeardown(
  'flowSlice',
  ['flowPanelVisible', 'flowRunning', 'flowLastRun', 'flowLastError'],
  {
    'session-reset': () => ({ flowPanelVisible: false, flowRunning: false, flowLastRun: null, flowLastError: null }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
