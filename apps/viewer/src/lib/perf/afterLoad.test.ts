/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The eager half of the after-load schedule: it loads the queue lazily and keeps
// the queue's contract (bound to the model, cancel drops) while the queue loads.
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '../../store/index.js';
import type { FederatedModel } from '../../store/types.js';
import { __setAfterLoadQueueLoaderForTests, runAfterModelSettled } from './afterLoad.js';

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
  __setAfterLoadQueueLoaderForTests(null);
  await reset();
  window.requestIdleCallback = originalIdle;
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false, geometryStreamingActive: false } as never);
});

describe('afterLoad: the eager scheduling call', () => {
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

  describe('when the queue module does not load', () => {
    const failing = () => Promise.reject(new Error('chunk load failed'));
    it('still waits for the model to settle', async () => {
      __setAfterLoadQueueLoaderForTests(failing);
      setModels({ ...complete('a'), loadState: 'streaming-geometry' });
      let runs = 0;
      runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; });
      await flushIdle();
      assert.equal(runs, 0, 'not while the model streams');
      setModels(complete('a'));
      await flushIdle();
      assert.equal(runs, 1, 'once it settles');
    });

    it('a model removed (or its store replaced) before it settles: never runs, drops once', async () => {
      __setAfterLoadQueueLoaderForTests(failing);
      for (const after of [() => setModels(), () => setModels({ ...complete('a'), loadState: 'streaming-geometry' })]) {
        const store = fixtureDataStore();
        setModels({ ...fixtureModel('a'), ifcDataStore: store, loadState: 'streaming-geometry' });
        let runs = 0;
        let dropped = 0;
        runAfterModelSettled({ job: 'source-compaction', modelId: 'a', store }, () => { runs++; }, () => { dropped++; });
        await flushIdle();
        after(); // removal, or a reload: a new store under the same id
        setModels(complete('a'));
        await flushIdle();
        assert.equal(runs, 0, 'the job does not run for the replaced or removed model');
        assert.equal(dropped, 1, 'its owner hears of the drop once');
      }
    });

    it('a started job: its model\'s removal aborts its signal; a cancel before it starts drops once', async () => {
      __setAfterLoadQueueLoaderForTests(failing);
      setModels(complete('a'));
      let signal: AbortSignal | null = null;
      runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, (s) => { signal = s; return new Promise(() => {}); });
      await flushIdle();
      assert.equal(signal !== null && !(signal as AbortSignal).aborted, true, 'it runs');
      setModels();
      assert.equal((signal as unknown as AbortSignal).aborted, true, 'removal aborts it');
      setModels({ ...complete('b'), loadState: 'streaming-geometry' });
      let dropped = 0;
      const cancel = runAfterModelSettled({ job: 'overlay-parse', modelId: 'b' }, () => {}, () => { dropped++; });
      await flushIdle();
      cancel(); cancel();
      assert.equal(dropped, 1);
    });
  });
});

