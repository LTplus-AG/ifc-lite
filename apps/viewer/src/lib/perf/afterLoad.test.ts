/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The eager half of the after-load schedule: it loads the queue lazily and keeps
// the queue's contract (bound to the model, cancel drops) while the queue loads.
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture';
import { settleLoadWindow } from '@/test/load-window';
import { viewerLoadWindow } from '@/hooks/loadWindow';
import { markModelLoadEnded } from '@/hooks/modelLoadEnd';
import { useViewerStore } from '../../store/index.js';
import type { FederatedModel } from '../../store/types.js';
import { __setAfterLoadQueueLoaderForTests, __setOwnHoldCapForTests, runAfterModelSettled } from './afterLoad.js';

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
  __setOwnHoldCapForTests(null);
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

  it('a model whose record is already complete waits for the load window: no job until the settled frame has painted', async () => {
    // A cache hit: the finalize publish marks the record complete while the store still loads.
    useViewerStore.setState({ loading: true } as never);
    setModels(complete('a'));
    let runs = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0, 'not while the load window is open (record complete, store still loading)');
    useViewerStore.setState({ loading: false } as never); // settleLoadUi
    assert.equal(viewerLoadWindow().isOpen(), true, 'still open in the task that settles the load: it closes behind the next painted frame');
    assert.equal(runs, 0);
    await settleLoadWindow();
    await flushIdle();
    assert.equal(runs, 1, 'runs once the settled frame has painted and an idle period comes');
  });

  // #9915 review G1/G2: each job is gated on ITS model's hold, and that hold is capped.
  const CAP = 80;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const streaming = (id: string): FederatedModel => ({ ...complete(id), loadState: 'streaming-geometry' });
  /** A multi-file open: the window opens while `a` loads; `a` settles and `b` starts before the window can close. */
  async function multiFileOpen(): Promise<void> {
    await settleLoadWindow();
    useViewerStore.setState({ loading: true, geometryStreamingActive: true, activeModelId: 'a', models: new Map([['a', streaming('a')]]) } as never);
    useViewerStore.setState({ activeModelId: 'b' } as never);
    setModels(complete('a'), streaming('b'));
    assert.equal(viewerLoadWindow().isHeld('a'), true, 'a was loading when the window opened: the window holds it');
  }

  it('another model\'s load does not hold a model that had settled when it began', async () => {
    await settleLoadWindow();
    setModels(complete('a'));
    useViewerStore.setState({ loading: true, geometryStreamingActive: true, activeModelId: 'b', models: new Map([['a', complete('a')], ['b', streaming('b')]]) } as never);
    assert.equal(viewerLoadWindow().isOpen(), true, 'b\'s load window is open');
    let runs = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 1, 'a\'s job runs while b loads');
  });

  it('a multi-file open: an earlier model\'s job runs once its own hold reaches the cap, while the later file still loads (G1)', async () => {
    __setOwnHoldCapForTests(CAP);
    await multiFileOpen();
    let runs = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0, 'held right after a settles: its settled frame may not have painted');
    await wait(CAP + 20);
    await flushIdle();
    assert.equal(runs, 1, 'runs at the cap');
    assert.equal(viewerLoadWindow().isOpen(), true, 'while b still loads');
  });

  it('a multi-file open: an earlier model\'s job runs once the loader ends ITS load and a frame paints, not at the end of the open (#9855 462c14fc59)', async () => {
    await multiFileOpen(); // the default 3 s cap: it must not be what releases a
    let runs = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0, 'held until the loader ends a\'s load');
    markModelLoadEnded('a'); // settleOwnedLoadUi for a's file
    await settleLoadWindow();
    await flushIdle();
    assert.equal(runs, 1, 'runs behind a\'s settled frame');
    assert.equal(viewerLoadWindow().isHeld('b'), true, 'while b still loads');
  });

  it('a window that never closes: the job of the model it holds runs at the cap once that model settled (G2)', async () => {
    __setOwnHoldCapForTests(CAP);
    await settleLoadWindow();
    useViewerStore.setState({ loading: true, geometryStreamingActive: false, activeModelId: 'a', models: new Map([['a', streaming('a')]]) } as never);
    setModels(complete('a')); // a settled; the load flag is never cleared
    let runs = 0;
    runAfterModelSettled({ job: 'search-index', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0);
    await wait(CAP + 20);
    await flushIdle();
    assert.equal(runs, 1);
    assert.equal(useViewerStore.getState().loading, true, 'the flag is still set');
  });

  it('a model removed while its window holds its job: the job never runs and its owner hears of the drop', async () => {
    __setOwnHoldCapForTests(CAP);
    await multiFileOpen();
    let runs = 0;
    let dropped = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => { runs++; }, () => { dropped++; });
    await flushIdle();
    setModels(streaming('b'));
    await wait(CAP + 20);
    await flushIdle();
    assert.equal(runs, 0);
    assert.equal(dropped, 1);
  });

  it('a held model removed: its data store is not kept by the hold bookkeeping (review)', async () => {
    __setOwnHoldCapForTests(CAP);
    const ref = await (async (): Promise<WeakRef<object>> => {
      await multiFileOpen();
      const store = fixtureDataStore();
      setModels({ ...complete('a'), ifcDataStore: store }, streaming('b'));
      runAfterModelSettled({ job: 'source-compaction', modelId: 'a' }, () => {});
      await flushIdle(); // held: the hold's start is recorded for this store
      return new WeakRef(store);
    })();
    setModels(streaming('b'));
    await flushIdle();
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let i = 0; i < 10 && ref.deref(); i++) { await ticks(1); gc(); }
    assert.equal(ref.deref() === undefined, true, 'the removed model\'s store can be collected');
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

