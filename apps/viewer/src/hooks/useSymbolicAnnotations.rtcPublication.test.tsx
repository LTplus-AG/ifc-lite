/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

beforeEach(() => {
  __resetSymbolicAnnotationsCacheForTests();
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    geometryResult: null,
    loading: false,
    hiddenEntities: new Set<number>(),
    lensHiddenIds: new Set<number>(),
    hiddenEntitiesByModel: new Map(),
    hostHiddenIfcTypes: null,
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

it('retries a mounted legacy-primary symbolic parse when loading resolves without an exact frame (#4799)', async () => {
  const store = fixtureDataStore([{ expressId: 7, type: 'IfcAnnotation' }]);
  store.source = contiguousSourceBytes(new TextEncoder().encode('legacy pending symbolic #4799'));
  const posts: Array<{ id: number; frame?: unknown }> = [];
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(request: { id: number; frame?: unknown }) {
        posts.push(request);
        queueMicrotask(() => worker.onmessage?.({
          data: { id: request.id, ok: true, flat: createEmptyFlatSymbolic() },
        }));
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
    useViewerStore.setState({ ifcDataStore: store, loading: true } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(posts.length, 0, 'pending provenance must not guess a standalone frame');

    await act(async () => {
      useViewerStore.setState({ loading: false } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(posts.length, 1, 'loading completion must retry without remounting the hook');
    assert.equal('frame' in posts[0], false, 'completed provenance absence uses standalone detection');
  } finally {
    __setOverlayWorkerFactoryForTest(previous);
  }
});
