/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The eager half of the after-load schedule: it loads the queue lazily and keeps
// the queue's contract (bound to the model, cancel drops) while the queue loads.
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '../../store/index.js';
import type { FederatedModel } from '../../store/types.js';
import { runAfterModelSettled } from './afterLoad.js';

const idle: IdleRequestCallback[] = [];
const originalIdle = window.requestIdleCallback;
const reset = async () => (await import('./afterLoadIdle.js')).__resetAfterLoadIdleForTests();
function setModels(...list: FederatedModel[]): void {
  useViewerStore.setState({ models: new Map(list.map((m) => [m.id, m])) } as never);
}
const complete = (id: string): FederatedModel => ({ ...fixtureModel(id), ifcDataStore: fixtureDataStore(), loadState: 'complete' });
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function flushIdle(): Promise<void> {
  await ticks();
  for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 });
  await ticks();
}

beforeEach(async () => {
  await reset();
  idle.length = 0;
  window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, loading: false, geometryStreamingActive: false } as never);
});
afterEach(async () => {
  await reset();
  window.requestIdleCallback = originalIdle;
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false, geometryStreamingActive: false } as never);
});

describe('afterLoad: the eager scheduling call', () => {
  it('does not import the queue statically, and the queue imports no values (its lazy chunk preloads nothing)', () => {
    const valueImports = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
      .split('\n').filter((line) => /^import\s/.test(line) && !/^import type\s/.test(line));
    assert.equal(valueImports('./afterLoad.ts').some((line) => line.includes('afterLoadIdle')), false, 'no static value import of afterLoadIdle');
    assert.equal(readFileSync(new URL('./afterLoad.ts', import.meta.url), 'utf8').includes("import('./afterLoadIdle.js')"), true, 'loads it on first use');
    assert.deepEqual(valueImports('./afterLoadIdle.ts'), [], 'the queue takes the store through AfterLoadEnv');
  });

  it('runs the work through the queue: after the model settles and an idle period', async () => {
    setModels({ ...complete('a'), loadState: 'streaming-geometry' });
    let runs = 0;
    runAfterModelSettled({ job: 'search-index', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0, 'not while the model loads');
    setModels(complete('a'));
    await flushIdle();
    assert.equal(runs, 1);
  });

  it('a model removed while the queue loads: the job never runs and its owner hears of the drop', async () => {
    setModels(complete('a'));
    let runs = 0;
    let dropped = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; }, () => { dropped++; });
    setModels(); // before the queue module has resolved
    await flushIdle();
    assert.equal(runs, 0);
    assert.equal(dropped, 1);
  });

  it('cancelled before the queue loads: never runs, drops once', async () => {
    setModels(complete('a'));
    let runs = 0;
    let dropped = 0;
    const cancel = runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; }, () => { dropped++; });
    cancel();
    cancel();
    await flushIdle();
    assert.equal(runs, 0);
    assert.equal(dropped, 1);
  });
});
