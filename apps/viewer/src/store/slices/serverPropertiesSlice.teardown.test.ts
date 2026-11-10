/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { viewerTeardownRegistry } from '../teardown-registry.js';
import type { ServerPropertiesRun } from './serverPropertiesSlice.js';

function contribution() {
  const entry = viewerTeardownRegistry.find(entry => entry.slice === 'serverPropertiesSlice');
  assert.ok(entry);
  return entry;
}
function records() {
  return new Map<string, ServerPropertiesRun>([
    ['removed', { kind: 'cancelled', runId: 1, reason: 'scope' }],
    ['kept', { kind: 'succeeded', runId: 2, result: undefined }],
  ]);
}

it('#9601 model-removed drops only that model property run without mutating the input', () => {
  const runs = records();
  const patch = contribution().teardown({
    kind: 'model-removed', modelId: 'removed', isStale: () => false, nextActiveModelId: 'kept',
  }, { serverPropertiesRuns: runs });
  assert.ok(patch.serverPropertiesRuns);
  assert.deepEqual([...patch.serverPropertiesRuns.keys()], ['kept']);
  assert.equal(patch.serverPropertiesRuns.get('kept') === runs.get('kept'), true);
  assert.deepEqual([...runs.keys()], ['removed', 'kept']);
});
it('#9601 all-models-cleared drops every model property run without mutating the input', () => {
  const runs = records();
  const patch = contribution().teardown({ kind: 'all-models-cleared' }, { serverPropertiesRuns: runs });
  assert.ok(patch.serverPropertiesRuns);
  assert.equal(patch.serverPropertiesRuns.size, 0);
  assert.deepEqual([...runs.keys()], ['removed', 'kept']);
});
