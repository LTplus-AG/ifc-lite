/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rememberRunRequest, rerunClashRequest, runRequestOf, type ClashRunRequest } from './run-request.js';

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    runners: {
      runAll: async () => { calls.push('all'); },
      runMatrix: async () => { calls.push('matrix'); },
      runPreset: async (id: string) => { calls.push(`preset:${id}`); },
      runDuplicates: async () => { calls.push('duplicates'); },
    },
  };
}

describe('clash run request (#5818)', () => {
  it('dispatches each recorded kind to its own runner', async () => {
    const cases: Array<[ClashRunRequest | null, string]> = [
      [{ kind: 'all' }, 'all'],
      [{ kind: 'matrix' }, 'matrix'],
      [{ kind: 'preset', presetId: 'p1', name: 'P1' }, 'preset:p1'],
      [{ kind: 'duplicates' }, 'duplicates'],
      [null, 'all'], // nothing recorded: the first-run default
    ];
    for (const [request, expected] of cases) {
      const { calls, runners } = recorder();
      await rerunClashRequest(request, runners);
      assert.deepEqual(calls, [expected]);
    }
  });

  it('keys the request by result object, so a new result does not inherit it', () => {
    const a = {};
    const b = {};
    rememberRunRequest(a, { kind: 'duplicates' });
    rememberRunRequest(b, null);
    assert.deepEqual(runRequestOf(a), { kind: 'duplicates' });
    assert.equal(runRequestOf(b), null);
    assert.equal(runRequestOf(null), null);
  });
});
