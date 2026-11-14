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
import { resetFeaturesForTest } from '@/lib/features';
import { fastPathSwitch, MODEL_SOURCES, pageCanOpenModels, startFastPath } from './startFastPath';

const desktop = { deviceMemory: 8, connection: { saveData: false } } as unknown as Navigator;
const setSearch = (search: string) => window.history.replaceState(null, '', `/${search}`);
afterEach(() => { setSearch(''); resetFeaturesForTest(); });

/** `startFastPath()` declines and no worker is constructed. */
function assertStartsNothing(): void {
  let spawned = 0;
  const priorWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { spawned++; } } as unknown as typeof Worker;
  try {
    assert.equal(startFastPath(), false);
    assert.equal(spawned, 0);
  } finally {
    globalThis.Worker = priorWorker;
  }
}

describe('fast path kill switch', () => {
  it('is a registered kill switch, on by default; flipping the registry default is the one-line off switch', () => {
    const flag = getPerfFlagDefinition('fastPath');
    assert.equal(flag.kind, 'kill-switch');
    assert.equal(flag.bindings.urlParam, 'perf.fastPath');
    assert.equal(flag.default, true);
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

  it('?perf.fastPath=0 and ?perf.fastPath=false turn it off for the session', () => {
    setSearch('?perf.fastPath=0');
    assert.equal(mayWarmUp(fastPathSwitch(), desktop), false);
    setSearch('?perf.fastPath=false');
    assert.equal(mayWarmUp(fastPathSwitch(), desktop), false);
    assert.equal(readPerfFlag('fastPath'), 'false');
  });

  it('with ?perf.fastPath=0 the runtime starts nothing and spawns no worker', () => {
    setSearch('?perf.fastPath=0');
    assertStartsNothing();
  });

  it('a page that can open no model warms nothing: no sample fetch, no worker', () => {
    resetFeaturesForTest({ default: 'all', disable: [...MODEL_SOURCES] });
    assertStartsNothing();
  });

  it('any one model source left on keeps the warm-up: local files, samples, cloud sources, federation setup or ?model=', () => {
    assert.equal(pageCanOpenModels(), true, 'no host configuration');
    for (const kept of MODEL_SOURCES) {
      resetFeaturesForTest({ default: 'all', disable: MODEL_SOURCES.filter((id) => id !== kept) });
      assert.equal(pageCanOpenModels(), true, `${kept} on`);
    }
    resetFeaturesForTest({ default: 'all', disable: [...MODEL_SOURCES] });
    setSearch('?model=');
    assert.equal(pageCanOpenModels(), false, 'an empty ?model= loads nothing');
    setSearch('?model=samples/hello-wall.ifc');
    assert.equal(pageCanOpenModels(), true, '?model= autoloads a model with every picker off');
  });
});
