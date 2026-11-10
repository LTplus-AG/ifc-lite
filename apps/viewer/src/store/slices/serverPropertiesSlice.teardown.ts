/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineSliceTeardown } from '../teardown.js';

export const serverPropertiesTeardown = defineSliceTeardown('serverPropertiesSlice', ['serverPropertiesRuns'], {
  'session-reset': () => ({ serverPropertiesRuns: new Map() }),
  'all-models-cleared': () => ({ serverPropertiesRuns: new Map() }),
  'model-removed': (scope, state) => {
    const runs = new Map(state.serverPropertiesRuns);
    runs.delete(scope.modelId);
    return { serverPropertiesRuns: runs };
  },
});

