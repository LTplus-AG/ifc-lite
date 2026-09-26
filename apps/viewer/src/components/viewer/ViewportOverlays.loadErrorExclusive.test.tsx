/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 review (NIT) — the loading card and the load-error card both centre
 * themselves in the same viewport slot. A failure can land while `loading`
 * has not yet flipped false for an unrelated concurrent load (or simply
 * before React has batched the two writes), so both used to be able to
 * mount at once. `ViewportOverlays` now renders exactly one — error wins.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ViewportOverlays } from './ViewportOverlays';

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ loading: false, error: null, loadingFileName: null }));
});

function renderOverlays(): HTMLElement {
  return render(<ViewportOverlays hideViewCube hideAxis hideScale />);
}

describe('ViewportOverlays — exactly one of loading/error card (#5851)', () => {
  it('shows only the error card when both loading and error are set', () => {
    act(() => useViewerStore.setState({ loading: true, error: 'boom', loadingFileName: 'broken.ifc' }));
    const container = renderOverlays();
    assert.ok(container.querySelector('[data-viewport-load-error-card]'), 'the error card renders');
    assert.equal(container.querySelector('[data-viewport-loading-card]'), null, 'the loading card does not');
  });

  it('shows the loading card when only loading is set', () => {
    act(() => useViewerStore.setState({ loading: true, error: null, loadingFileName: 'model.ifc' }));
    const container = renderOverlays();
    assert.ok(container.querySelector('[data-viewport-loading-card]'), 'the loading card renders');
    assert.equal(container.querySelector('[data-viewport-load-error-card]'), null);
  });

  it('shows neither when idle', () => {
    act(() => useViewerStore.setState({ loading: false, error: null }));
    const container = renderOverlays();
    assert.equal(container.querySelector('[data-viewport-loading-card]'), null);
    assert.equal(container.querySelector('[data-viewport-load-error-card]'), null);
  });
});
