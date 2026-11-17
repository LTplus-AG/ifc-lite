/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Load failures stay visible after removing the progress popup (#10251). */
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

describe('ViewportOverlays — load error visibility (#10251)', () => {
  it('shows only the error card when both loading and error are set', () => {
    act(() => useViewerStore.setState({ loading: true, error: 'boom', loadingFileName: 'broken.ifc' }));
    const container = renderOverlays();
    assert.ok(container.querySelector('[data-viewport-load-error-card]'), 'the error card renders');
    assert.ok(!container.querySelector('[data-viewport-loading-card]'), 'the loading card does not');
  });

  it('shows no loading popup while loading', () => {
    act(() => useViewerStore.setState({ loading: true, error: null, loadingFileName: 'model.ifc' }));
    const container = renderOverlays();
    // Keep failures scalar: inspecting a happy-dom element can overwhelm the
    // reverted-code oracle when the old popup is deliberately restored.
    assert.ok(!container.querySelector('[data-viewport-loading-card]'), 'loading adds no popup');
    assert.ok(!container.querySelector('[data-viewport-load-error-card]'));
  });

  it('shows neither when idle', () => {
    act(() => useViewerStore.setState({ loading: false, error: null }));
    const container = renderOverlays();
    assert.ok(!container.querySelector('[data-viewport-loading-card]'));
    assert.ok(!container.querySelector('[data-viewport-load-error-card]'));
  });
});
