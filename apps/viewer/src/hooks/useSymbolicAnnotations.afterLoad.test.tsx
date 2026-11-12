/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reopen lane, step 2: the symbolic overlay parse (annotations, grids) is not
 * part of becoming interactive. A load still streaming geometry publishes its
 * store early; the parse waits until the load settles and the page is idle,
 * instead of taking main-thread time between "model on screen" and
 * "interactive" (~0.14 s on a Holter reopen).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import { fixtureDataStore } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types';
import { fixtureModel } from '@/test/store-fixture';
import { __resetAfterLoadIdleForTests } from '@/lib/perf/afterLoadIdle';
import { __resetSymbolicAnnotationsCacheForTests, getDisplayParseFor, getParseFor } from './symbolic-parse-cache.js';
import { useSymbolicAnnotations } from './useSymbolicAnnotations.js';

let root: Root | null = null;
let container: HTMLElement | null = null;
const idle: IdleRequestCallback[] = [];
const originalIdle = window.requestIdleCallback;

beforeEach(() => {
  __resetSymbolicAnnotationsCacheForTests();
  __resetAfterLoadIdleForTests();
  idle.length = 0;
  window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
  useViewerStore.setState({
    models: new Map(), activeModelId: null, ifcDataStore: null, geometryResult: null, loading: false, geometryStreamingActive: false,
    hiddenEntities: new Set<number>(), lensHiddenIds: new Set<number>(), hostHiddenIfcTypes: null,
  } as never);
});

afterEach(async () => {
  window.requestIdleCallback = originalIdle;
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  __resetAfterLoadIdleForTests();
  useViewerStore.setState({ models: new Map(), mutationViews: new Map(), mutationVersion: 0, activeModelId: null, geometryStreamingActive: false, loading: false } as never);
});

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it('parses the overlay of a store published mid-load only after the load settles and the page is idle', async () => {
  const store = fixtureDataStore([{ expressId: 7, type: 'IfcAnnotation' }]);
  store.source = contiguousSourceBytes(new TextEncoder().encode('symbolic after load'));
  let posts = 0;
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(request: { id: number }) {
        posts++;
        queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: createEmptyFlatSymbolic() } }));
      },
      terminate() {},
    };
    return worker as unknown as Worker;
  });
  function Probe(): null {
    useSymbolicAnnotations({ enabled: true });
    return null;
  }
  try {
    // The store is published (standalone frame: loading is false) while geometry still streams.
    useViewerStore.setState({ ifcDataStore: store, geometryStreamingActive: true } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); });
    await tick();
    assert.equal(posts, 0, 'no parse while the load streams');

    await act(async () => { useViewerStore.setState({ geometryStreamingActive: false } as never); });
    await tick();
    assert.equal(posts, 0, 'settled: the parse waits for an idle period');

    await act(async () => { for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); });
    await tick();
    assert.equal(posts, 1, 'parsed once the page is idle');
  } finally {
    __setOverlayWorkerFactoryForTest(previous);
  }
});

it('a settled model\'s overlay re-parses at once while another model loads, and shows its last parse until the new one lands', async () => {
  const storeA = fixtureDataStore([{ expressId: 7, type: 'IfcAnnotation' }, { expressId: 8, type: 'IfcGrid' }]);
  storeA.source = contiguousSourceBytes(new TextEncoder().encode('model A grids'));
  storeA.schemaVersion = 'IFC4';
  const storeB = fixtureDataStore([{ expressId: 9, type: 'IfcAnnotation' }]);
  storeB.source = contiguousSourceBytes(new TextEncoder().encode('model B, still loading'));
  const replies: Array<() => void> = [];
  let posts = 0;
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(request: { id: number }) {
        posts++;
        replies.push(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: createEmptyFlatSymbolic() } }));
      },
      terminate() {},
    };
    return worker as unknown as Worker;
  });
  const release = () => act(async () => { for (const reply of replies.splice(0)) reply(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const model = (id: string, store: typeof storeA, loadState: FederatedModel['loadState']) => ({ ...fixtureModel(id), ifcDataStore: store, loadState });
  function Probe(): null {
    useSymbolicAnnotations({ enabled: true });
    return null;
  }
  try {
    // A is on screen with its overlay; a federated add of B is in progress (the add sets `loading` for its whole run).
    useViewerStore.setState({ models: new Map([['a', model('a', storeA, 'complete')], ['b', model('b', storeB, 'streaming-geometry')]]),
      activeModelId: 'b', loading: true, geometryStreamingActive: true, mutationViews: new Map(), mutationVersion: 0 } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); });
    await tick();
    assert.equal(posts, 1, 'A parses at once: B\'s load does not hold a settled model back');
    await release();
    const before = getParseFor({ store: storeA });
    assert.ok(before, 'A\'s parse landed');

    // The user edits A while B still loads: A's key changes (pending changes + mutationVersion).
    const view = new MutablePropertyView(null, 'a');
    view.deleteEntity(7);
    let pendingShown = false;
    let exactBefore: unknown = null;
    await act(async () => {
      useViewerStore.setState({ mutationViews: new Map([['a', view]]), mutationVersion: 1 } as never);
      // Before the re-parse runs: no parse for the new key yet, and the overlay keeps A's last one.
      exactBefore = getParseFor({ store: storeA, mutationView: view });
      pendingShown = getDisplayParseFor({ store: storeA, mutationView: view }) === before;
    });
    assert.equal(exactBefore, undefined, 'the edited key has no parse until the re-parse lands');
    assert.equal(pendingShown, true, 'meanwhile the overlay keeps A\'s last parse');
    await tick();
    assert.equal(idle.length, 0, 'nothing waits for an idle period');
    const after = getParseFor({ store: storeA, mutationView: view });
    assert.equal(after !== undefined && after !== before, true, 'the re-parse ran at once, without waiting for B');
    assert.equal(getDisplayParseFor({ store: storeA, mutationView: view }) === after, true, 'and replaces the last parse');
    assert.equal(posts, 1, 'B (still loading) is not parsed');
  } finally {
    __setOverlayWorkerFactoryForTest(previous);
  }
});
