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
import { __resetSymbolicAnnotationsCacheForTests } from './symbolic-parse-cache.js';
import { useSymbolicAnnotations } from './useSymbolicAnnotations.js';

let root: Root | null = null;
let container: HTMLElement | null = null;
const idle: IdleRequestCallback[] = [];
const originalIdle = window.requestIdleCallback;

beforeEach(() => {
  __resetSymbolicAnnotationsCacheForTests();
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
  useViewerStore.setState({ geometryStreamingActive: false, loading: false } as never);
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
