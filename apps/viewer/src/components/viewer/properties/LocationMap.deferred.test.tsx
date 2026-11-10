/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { LocationMap } from './LocationMap.js';

for (const trigger of ['visible', 'settled'] as const) {
  it(`NEW-7: real LocationMap waits for ${trigger} before touching WebGL`, async () => {
    const original = globalThis.IntersectionObserver;
    const loading = useViewerStore.getState().loading;
    let callback: IntersectionObserverCallback | undefined;
    let observed: Element | undefined;
    let observer: IntersectionObserver | undefined;
    class Observer implements IntersectionObserver {
      constructor(notify: IntersectionObserverCallback) { callback = notify; observer = this; }
      observe(element: Element) { observed = element; }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly scrollMargin = '0px';
      readonly thresholds = [0.01];
    }
    globalThis.IntersectionObserver = Observer;
    let probes = 0;
    const context = mock.method(HTMLCanvasElement.prototype, 'getContext', () => { probes++; return null; });
    resetMapWebglSupportForTests();
    useViewerStore.setState({ loading: true });
    try {
      render(<LocationMap mapConversion={{ id: 1, sourceCRS: 2, targetCRS: 3,
        eastings: 500_000, northings: 4_000_000, orthogonalHeight: 0 }}
        projectedCRS={{ id: 3, name: 'EPSG:32632', mapUnitScale: 1 }} />);
      // Main (with production reverted) reaches the GPU; the branch observes
      // visibility first. Both paths execute the existing real component.
      await waitFor(() => !!observed || probes > 0, 'resolved map reaches visibility gate or WebGL');
      assert.equal(probes, 0, 'hidden loading panel must not acquire a context');
      if (trigger === 'settled') act(() => useViewerStore.setState({ loading: false }));
      else {
        assert.ok(callback && observer && observed);
        act(() => callback?.([{ target: observed, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], observer!));
      }
      await waitFor(() => probes > 0, 'visible/settled map now attempts real WebGL setup');
    } finally {
      cleanup();
      context.mock.restore();
      globalThis.IntersectionObserver = original;
      resetMapWebglSupportForTests();
      useViewerStore.setState({ loading });
    }
  });
}
