/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect, useRef } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useLocationMapReady } from './use-location-map-ready.js';

it('NEW-7: map work waits for panel visibility or load settlement', () => {
  const original = globalThis.IntersectionObserver;
  const originalLoading = useViewerStore.getState().loading;
  let notify: IntersectionObserverCallback = () => {};
  let observed: Element | undefined;
  class Observer {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe(element: Element) { observed = element; }
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0];
  }
  globalThis.IntersectionObserver = Observer;
  let starts = 0;
  function Panel() {
    const ref = useRef<HTMLDivElement>(null);
    const ready = useLocationMapReady(ref, true);
    useEffect(() => { if (ready) starts++; }, [ready]);
    return <div ref={ref} />;
  }
  try {
    useViewerStore.setState({ loading: true });
    render(<Panel />);
    assert.ok(observed);
    assert.equal(starts, 0);
    act(() => notify([{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry], new Observer(notify)));
    assert.equal(starts, 0);
    act(() => notify([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], new Observer(notify)));
    assert.equal(starts, 1);
    cleanup();
    starts = 0;
    render(<Panel />);
    assert.equal(starts, 0);
    act(() => useViewerStore.setState({ loading: false }));
    assert.equal(starts, 1);
  } finally {
    cleanup();
    globalThis.IntersectionObserver = original;
    useViewerStore.setState({ loading: originalLoading });
  }
});
