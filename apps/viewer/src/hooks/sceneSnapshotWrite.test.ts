/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// W2 (load hillclimb, reopen lane, #9728): the deferred write of a captured
// finished scene beside its cache entry, and every way it declines to store.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneSnapshot } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '../store/index.js';
import { clearCache, getCached } from '../services/ifc-cache.js';
import { entryOf, immediateIdle, putSnapshots, restoreIdle, snapshotTrace, storedSnapshot } from '../test/scene-snapshot-fixture.js';
import { writeCapturedScene, type CapturedScene } from './sceneSnapshotWrite.js';
import { __resetAfterLoadIdleForTests } from '../lib/perf/afterLoadIdle.js';
import { fixtureModel } from '../test/store-fixture.js';

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } };

function snapshot(): SceneSnapshot {
  return {
    policy: 'p', pieceCount: 1, nextSplitId: 1, sharedFrameOrigins: [], activeBuckets: [],
    batches: [{ key: 'k', color: [1, 0, 0, 1], vertexBytes: 28, expressIds: new Uint32Array([7]), ordinals: new Uint32Array([0]),
      vertexData: new Uint8Array(28).fill(3), indices: new Uint32Array([0, 0, 0]) }],
  };
}

const SOURCE = { expressId: 7 } as MeshData;
const captured = (over: Partial<CapturedScene> = {}): CapturedScene => ({
  snapshot: snapshot(), sources: [SOURCE], key: 'policy|types', policyNow: () => 'p', loadFailed: () => false, changedSince: () => null,
  fit: { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null } as unknown as CapturedScene['fit'], ...over,
});

/** Run the writer for `c` with a span begun the way the capture begins it; resolves its outcome and the span's. */
async function write(c: CapturedScene, entry: Parameters<typeof writeCapturedScene>[1], isStale = () => false, modelId: string | null = null) {
  const { trace, outcomes } = snapshotTrace();
  const outcome = await writeCapturedScene(c, entry, isStale, trace, trace.begin('cache.writeSceneSnapshot'), modelId);
  return { outcome, span: outcomes()[0] };
}

beforeEach(async () => {
  putSnapshots.clear();
  await clearCache();
  __resetAfterLoadIdleForTests();
  useViewerStore.setState({ models: new Map(), loading: true, geometryStreamingActive: false });
  immediateIdle();
});
afterEach(() => {
  restoreIdle();
  __resetAfterLoadIdleForTests();
  useViewerStore.setState({ models: new Map(), loading: false, geometryStreamingActive: false });
});

describe('writeCapturedScene', () => {
  it('waits for the load to be interactive, then stores the frozen scene with its entry\'s shard location', async () => {
    const entry = await entryOf('a');
    const { trace, outcomes } = snapshotTrace();
    const written = writeCapturedScene(captured(), Promise.resolve(entry), () => false, trace, trace.begin('cache.writeSceneSnapshot'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await getCached('a'))!.sceneSnapshot, undefined, 'nothing is written while the load is still running');
    assert.deepEqual(outcomes(), [], 'the pending write keeps its span open');
    useViewerStore.setState({ loading: false });
    assert.equal(await written, 'written');
    assert.equal((await getCached('a'))!.sceneSnapshotKey, 'policy|types');
    const decoded = await storedSnapshot('a');
    assert.deepEqual(decoded?.hostData, { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null, shards: { offset: 16, size: 8 } });
    assert.deepEqual([...decoded!.batches[0].vertexData], [...snapshot().batches[0].vertexData]);
    assert.deepEqual(outcomes(), ['written']);
  });

  it('drops the capture when another file opens before the load settles', async () => {
    const entry = await entryOf('b');
    let stale = false;
    const pending = write(captured(), Promise.resolve(entry), () => stale);
    stale = true;
    assert.deepEqual(await pending, { outcome: 'abandoned', span: 'abandoned:superseded' });
    assert.equal((await getCached('b'))!.sceneSnapshot, undefined);
  });

  // #9728 review: a load that failed for good never writes its entry; the capture must not wait 10 minutes for it.
  it('releases the capture of a load that failed instead of waiting for its entry', async () => {
    useViewerStore.setState({ loading: false });
    let failed = false;
    const started = Date.now();
    const pending = write(captured({ loadFailed: () => failed }), new Promise(() => {}));
    failed = true;
    assert.deepEqual(await pending, { outcome: 'abandoned', span: 'abandoned:load-failed' });
    assert.ok(Date.now() - started < 2000, 'released within a poll or two');
  });

  it('does not store batches built under a policy the scene has since left (quantized admission landed late)', async () => {
    const entry = await entryOf('q');
    useViewerStore.setState({ loading: false });
    assert.equal((await write(captured({ policyNow: () => 'quantized-now' }), Promise.resolve(entry))).outcome, 'policy-changed');
    assert.equal((await getCached('q'))!.sceneSnapshot, undefined);
  });

  // #9728 review: the entry is serialized from the live meshes after the swap, so an edit since then
  // (gizmo move, edit card, exploded levels) would leave entry and snapshot disagreeing.
  it('does not store a capture the scene has changed since, and says why', async () => {
    useViewerStore.setState({ loading: false });
    for (const reason of ['scene-changed', 'level-offsets']) {
      const entry = await entryOf(`c-${reason}`);
      assert.deepEqual(await write(captured({ changedSince: () => reason }), Promise.resolve(entry)), { outcome: 'scene-changed', span: `scene-changed:${reason}` });
      assert.equal((await getCached(`c-${reason}`))!.sceneSnapshot, undefined);
    }
  });

  it('moves a cold capture\'s ordinals to the order its entry stores the meshes in, and skips one hydration would refuse', async () => {
    useViewerStore.setState({ loading: false });
    const [a, b] = [{ expressId: 1 } as MeshData, { expressId: 2 } as MeshData];
    const two = captured({ sources: [a, b], snapshot: { ...snapshot(), pieceCount: 2,
      batches: [{ ...snapshot().batches[0], expressIds: new Uint32Array([1, 2]), ordinals: new Uint32Array([0, 1]) }] } });
    const entry = { ...(await entryOf('o')), meshOrder: [b, a] };
    assert.equal((await write(two, Promise.resolve(entry))).outcome, 'written');
    assert.deepEqual([...(await storedSnapshot('o'))!.batches[0].ordinals], [1, 0], 'a reopen decodes b first, so a is piece 1');
    assert.equal((await write(two, Promise.resolve({ ...entry, meshOrder: [b] }))).outcome, 'order-mismatch');
  });

  it('writes nothing when the load stored no entry', async () => {
    useViewerStore.setState({ loading: false });
    assert.equal((await write(captured(), Promise.resolve(null))).outcome, 'no-entry');
  });

  // #9728 review: a throw while encoding or storing is a failure, not an intentional skip.
  it('reports a write that throws as failed, distinct from a declined one', async () => {
    useViewerStore.setState({ loading: false });
    const broken = snapshot();
    broken.batches[0].vertexData = Object.defineProperty({}, 'buffer', { get() { throw new TypeError('detached'); } }) as Uint8Array; // the encode throws
    assert.deepEqual(await write(captured({ snapshot: broken }), Promise.resolve(await entryOf('f'))), { outcome: 'failed', span: 'failed' });
  });

  it('waits for its own model only: another model\'s load does not hold the write back', async () => {
    const entry = await entryOf('m');
    useViewerStore.setState({ loading: true, geometryStreamingActive: true, activeModelId: 'other',
      models: new Map([['m', { ...fixtureModel('m'), loadState: 'complete' }], ['other', { ...fixtureModel('other'), loadState: 'streaming-geometry' }]]) } as never);
    assert.equal((await write(captured(), Promise.resolve(entry), () => false, 'm')).outcome, 'written');
  });

  it('a model removed before the write is abandoned and stores nothing', async () => {
    const entry = await entryOf('r');
    useViewerStore.setState({ models: new Map([['r', { ...fixtureModel('r'), loadState: 'streaming-geometry' }]]) } as never);
    const pending = write(captured(), Promise.resolve(entry), () => false, 'r');
    await new Promise((r) => setTimeout(r, 20));
    useViewerStore.setState({ models: new Map(), loading: false } as never);
    assert.deepEqual(await pending, { outcome: 'abandoned', span: 'abandoned:model-removed' });
    assert.equal((await getCached('r'))!.sceneSnapshot, undefined);
  });

  it('a load superseded while its write runs ends the span once, as abandoned, and stores nothing', async () => {
    const entry = await entryOf('s');
    useViewerStore.setState({ loading: false });
    let stale = false;
    const { trace, outcomes } = snapshotTrace();
    const outcome = await writeCapturedScene(captured({ policyNow: () => { stale = true; return 'p'; } }), Promise.resolve(entry), () => stale,
      trace, trace.begin('cache.writeSceneSnapshot'));
    await new Promise((r) => setTimeout(r, 300)); // past the supersession poll
    assert.equal(outcome, 'abandoned');
    assert.deepEqual(outcomes(), ['abandoned:superseded']);
    assert.equal((await getCached('s'))!.sceneSnapshot, undefined);
  });

  it('a model reloaded under the same id before the write drops the old capture\'s write', async () => {
    const entry = await entryOf('u');
    const first = { ...fixtureModel('u'), loadState: 'streaming-geometry' };
    useViewerStore.setState({ loading: false, models: new Map([['u', first]]) } as never);
    const pending = write(captured(), Promise.resolve(entry), () => false, 'u');
    await new Promise((r) => setTimeout(r, 20));
    useViewerStore.setState({ models: new Map([['u', { ...fixtureModel('u'), loadState: 'complete' }]]) } as never); // a new store
    assert.deepEqual(await pending, { outcome: 'abandoned', span: 'abandoned:model-removed' });
  });

  it('does not wait for an idle period in a hidden tab', async () => {
    const entry = await entryOf('h');
    useViewerStore.setState({ loading: false });
    window.requestIdleCallback = (() => 0) as typeof window.requestIdleCallback; // an idle period that never comes
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      assert.equal((await write(captured(), Promise.resolve(entry))).outcome, 'written');
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});
