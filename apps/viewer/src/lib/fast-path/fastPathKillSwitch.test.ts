/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fast path's off switch. `?perf.fastPath=0` turns it off for a session,
 * and the registry default (`default: true` in lib/perf/flags.ts) is the one
 * line that turns it off for everyone: with the switch off nothing is
 * prepared, no worker is spawned, and every load meshes as before.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPerfFlagDefinition, readPerfFlag } from '@/lib/perf/flags';
import { mayWarmUp } from '@/lib/warm-runtime-gate';

const desktop = { deviceMemory: 8, connection: { saveData: false } } as unknown as Navigator;
const setSearch = (search: string) => window.history.replaceState(null, '', `/${search}`);
afterEach(() => setSearch(''));

describe('fast path kill switch', () => {
  it('is a registered kill switch, on by default; flipping the registry default is the one-line off switch', async () => {
    const flag = getPerfFlagDefinition('fastPath');
    assert.equal(flag.kind, 'kill-switch');
    assert.equal(flag.bindings.urlParam, 'perf.fastPath');
    assert.equal(flag.default, true);
    const { fastPathSwitch } = await import('./startFastPath');
    setSearch('');
    assert.equal(mayWarmUp(fastPathSwitch(), desktop), true, 'unset: the registry default (on)');
    const def = flag as { default: unknown };
    def.default = false; // what the one-line change in lib/perf/flags.ts does
    try {
      assert.equal(mayWarmUp(fastPathSwitch(), desktop), false, 'a default of false turns it off with no URL parameter');
    } finally {
      def.default = true;
    }
  });

  it('?perf.fastPath=0 and ?perf.fastPath=false turn it off for the session', async () => {
    const { fastPathSwitch } = await import('./startFastPath');
    setSearch('?perf.fastPath=0');
    assert.equal(mayWarmUp(fastPathSwitch(), desktop), false);
    setSearch('?perf.fastPath=false');
    assert.equal(mayWarmUp(fastPathSwitch(), desktop), false);
    assert.equal(readPerfFlag('fastPath'), 'false');
  });

  it('with ?perf.fastPath=0 the runtime starts nothing and spawns no worker', async () => {
    setSearch('?perf.fastPath=0');
    let spawned = 0;
    const priorWorker = globalThis.Worker;
    globalThis.Worker = class { constructor() { spawned++; } } as unknown as typeof Worker;
    try {
      const { startFastPath } = await import('./startFastPath');
      assert.equal(startFastPath(), false);
      assert.equal(spawned, 0);
    } finally {
      globalThis.Worker = priorWorker;
    }
  });
});
