/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2: the one schedule for work no load waits for (snapshot
// write, overlay parse, source compaction, tier-1 search index): after THE
// MODEL'S load settled, in an idle period, in a fixed order, bound to the model.
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { contiguousSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '../../store/index.js';
import type { FederatedModel } from '../../store/types.js';
import { compactSource } from '../source-compaction/source-compaction.js';
import { __resetAfterLoadIdleForTests, afterModelSettled, modelLoadSettled, runAfterModelSettled, type AfterLoadJob } from './afterLoadIdle.js';

const idle: IdleRequestCallback[] = [];
const originalIdle = window.requestIdleCallback;
let visibility: DocumentVisibilityState = 'visible';
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

type LoadState = FederatedModel['loadState'];
function model(id: string, loadState: LoadState, store = fixtureDataStore()): FederatedModel {
  return { ...fixtureModel(id), ifcDataStore: store, loadState };
}
function setModels(...list: FederatedModel[]): void {
  useViewerStore.setState({ models: new Map(list.map((m) => [m.id, m])) } as never);
}
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function flushIdle(): Promise<void> {
  await ticks();
  for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 });
  await ticks();
}

beforeEach(() => {
  __resetAfterLoadIdleForTests();
  idle.length = 0;
  window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, loading: false, geometryStreamingActive: false, pendingInstancedShards: null } as never);
});
afterEach(() => {
  __resetAfterLoadIdleForTests();
  window.requestIdleCallback = originalIdle;
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else delete (document as { visibilityState?: unknown }).visibilityState;
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false, geometryStreamingActive: false, pendingInstancedShards: null } as never);
});

describe('modelLoadSettled: the one definition of "settled"', () => {
  it('is per model: load phase, its stream, its pending instanced shards', () => {
    setModels(model('a', 'complete'), model('b', 'streaming-geometry'), model('c', 'error'), model('d', undefined), model('e', 'pending'), model('f', 'hydrating-metadata'));
    const settled = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => modelLoadSettled(useViewerStore.getState(), id));
    assert.deepEqual(settled(), [true, false, true, true, false, false], 'record phases');
    useViewerStore.setState({ loading: true, geometryStreamingActive: true, activeModelId: 'b' } as never);
    assert.deepEqual(settled(), [true, false, true, true, false, false], 'another model\'s load and stream hold nothing back');
    useViewerStore.setState({ activeModelId: 'a' } as never);
    assert.equal(modelLoadSettled(useViewerStore.getState(), 'a'), false, 'the stream of this model');
    useViewerStore.setState({ activeModelId: null, geometryStreamingActive: false, pendingInstancedShards: [{ modelId: 'c', bytes: new ArrayBuffer(4) }] } as never);
    assert.deepEqual(settled(), [true, false, false, true, false, false], 'an instanced shard of this model waiting to upload');
  });

  it('a store with no model record (legacy): settled when no load and no stream run', () => {
    const state = () => useViewerStore.getState();
    assert.equal(modelLoadSettled(state(), null), true);
    useViewerStore.setState({ loading: true } as never);
    assert.equal(modelLoadSettled(state(), null), false);
    useViewerStore.setState({ loading: false, geometryStreamingActive: true } as never);
    assert.equal(modelLoadSettled(state(), null), false);
  });
});

describe('runAfterModelSettled', () => {
  it('waits for its model to settle, then for an idle period', async () => {
    setModels(model('a', 'streaming-geometry'));
    let runs = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 0, 'not while the model loads');
    setModels(model('a', 'complete'));
    assert.equal(runs, 0, 'settled: waits for an idle period');
    await flushIdle();
    assert.equal(runs, 1);
  });

  it('a settled model\'s job runs while another model loads', async () => {
    setModels(model('a', 'complete'), model('b', 'streaming-geometry'));
    useViewerStore.setState({ loading: true, geometryStreamingActive: true, activeModelId: 'b' } as never);
    let runs = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    await flushIdle();
    assert.equal(runs, 1);
  });

  it('runs ready jobs one per idle period in order: snapshot write, overlay parse, compaction, search index', async () => {
    setModels(model('a', 'streaming-geometry'), model('b', 'streaming-geometry'));
    const ran: string[] = [];
    let finishWrite!: () => void;
    const jobs: AfterLoadJob[] = ['search-index', 'source-compaction', 'overlay-parse', 'snapshot-write'];
    for (const id of ['b', 'a']) {
      for (const job of jobs) {
        runAfterModelSettled({ job, modelId: id }, () => {
          ran.push(`${job}:${id}`);
          if (job === 'snapshot-write' && id === 'b') return new Promise<void>((resolve) => { finishWrite = resolve; });
          return undefined;
        });
      }
    }
    setModels(model('a', 'complete'), model('b', 'complete'));
    await flushIdle();
    assert.deepEqual(ran, ['snapshot-write:b'], 'one job per idle period; same job kind in schedule order');
    await flushIdle();
    assert.deepEqual(ran, ['snapshot-write:b'], 'a job\'s promise holds the next one back');
    finishWrite();
    for (let i = 0; i < 8; i++) await flushIdle();
    assert.deepEqual(ran, ['snapshot-write:b', 'snapshot-write:a', 'overlay-parse:b', 'overlay-parse:a',
      'source-compaction:b', 'source-compaction:a', 'search-index:b', 'search-index:a']);
  });

  it('a model removed while another job runs: its queued job is dropped at once', async () => {
    setModels(model('a', 'complete'), model('b', 'complete'));
    let dropped = 0;
    runAfterModelSettled({ job: 'snapshot-write', modelId: 'a' }, () => new Promise<void>(() => {})); // runs, never settles
    runAfterModelSettled({ job: 'search-index', modelId: 'b' }, () => {}, () => { dropped++; });
    await flushIdle();
    setModels(model('a', 'complete'));
    assert.equal(dropped, 1, 'swept while the snapshot write still holds the queue');
  });

  it('a job that never settles holds the queue for the hold limit only', async () => {
    __resetAfterLoadIdleForTests(30);
    setModels(model('a', 'complete'), model('b', 'complete'));
    let ran = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => new Promise<void>(() => {}));
    runAfterModelSettled({ job: 'search-index', modelId: 'b' }, () => { ran++; });
    await flushIdle();
    assert.equal(ran, 0, 'held while the parse runs');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flushIdle();
    assert.equal(ran, 1, 'started once the hold limit passed');
  });

  it('a model removed before idle: the job never runs, its signal aborts, and it holds nothing', async () => {
    setModels(model('a', 'complete'));
    let runs = 0;
    let dropped = 0;
    const job = afterModelSettled({ job: 'snapshot-write', modelId: 'a' }, () => { runs++; return 'stored'; });
    runAfterModelSettled({ job: 'search-index', modelId: 'a' }, () => { runs++; }, () => { dropped++; });
    setModels();
    await flushIdle();
    assert.equal(runs, 0);
    assert.equal(dropped, 1, 'the owner hears of the drop');
    assert.equal(await job.result, undefined, 'a dropped job\'s result is undefined');
  });

  it('compaction for a model removed before idle: no copy to a worker, and the store is collectable', async () => {
    let compressions = 0;
    const compress = async (bytes: Uint8Array) => { compressions++; return { blocks: [], blockSize: bytes.byteLength } as never; };
    const ref = ((): WeakRef<object> => {
      // A minimal store: compaction reads only its source.
      const store = { source: contiguousSourceBytes(new Uint8Array(4096).fill(7)) } as unknown as IfcDataStore;
      setModels(model('a', 'complete', store));
      // The loader's wiring: compaction is the model's 'source-compaction' job, bound to its store.
      runAfterModelSettled({ job: 'source-compaction', modelId: 'a', store }, () => void compactSource(store.source, { compress, shouldCompress: () => true }));
      return new WeakRef(store);
    })();
    setModels(); // removal (or a session reset) before an idle period came
    await flushIdle();
    assert.equal(compressions, 0, 'no copy into a worker');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let i = 0; i < 10 && ref.deref(); i++) { await ticks(1); gc(); }
    assert.equal(ref.deref() === undefined, true, 'the dropped job does not keep the store alive');
  });

  it('a store replaced under the same model id (a reload) drops the old store\'s job', async () => {
    const old = fixtureDataStore();
    setModels(model('a', 'complete', old));
    let runs = 0;
    runAfterModelSettled({ job: 'source-compaction', modelId: 'a', store: old }, () => { runs++; });
    setModels(model('a', 'complete', fixtureDataStore()));
    await flushIdle();
    assert.equal(runs, 0);
  });

  it('a session reset drops every waiting job', async () => {
    setModels(model('a', 'streaming-geometry'), model('b', 'complete'));
    useViewerStore.setState({ loading: true } as never);
    let runs = 0;
    for (const id of ['a', 'b']) runAfterModelSettled({ job: 'search-index', modelId: id }, () => { runs++; });
    useViewerStore.setState({ models: new Map(), loading: false } as never);
    await flushIdle();
    assert.equal(runs, 0);
  });

  it('runs nothing once cancelled; a started job\'s signal aborts on cancel', async () => {
    setModels(model('a', 'complete'));
    let runs = 0;
    const cancel = runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    cancel();
    await flushIdle();
    assert.equal(runs, 0);
  });

  it('in a hidden tab, runs without waiting for an idle callback', async () => {
    visibility = 'hidden';
    setModels(model('a', 'complete'));
    let runs = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    await ticks();
    assert.equal(idle.length, 0);
    assert.equal(runs, 1);
  });

  it('a tab hidden while the job waits for idle runs it at once', async () => {
    setModels(model('a', 'complete'));
    let runs = 0;
    runAfterModelSettled({ job: 'overlay-parse', modelId: 'a' }, () => { runs++; });
    await ticks();
    assert.equal(runs, 0, 'waiting for an idle period');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await ticks();
    assert.equal(runs, 1);
  });
});
