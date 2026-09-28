/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { act, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useHoverOutline } from './useHoverOutline.js';

/**
 * `useHoverOutline` runs inside the Viewport, so every render it causes is a
 * full Viewport render. A hover pick writes a new `hoverState` (with the
 * cursor position) up to 20 times a second, and orbit/pan clear it on every
 * pointermove; only a change of the hovered ENTITY may re-render (#5390).
 */
describe('useHoverOutline', () => {
  afterEach(() => {
    cleanup();
    act(() => useViewerStore.getState().clearHover());
  });

  function mount() {
    let renders = 0;
    let requests = 0;
    const rendererRef = {
      current: { requestRender: () => { requests += 1; } },
    } as unknown as MutableRefObject<Renderer | null>;
    function Probe() {
      renders += 1;
      useHoverOutline(rendererRef);
      return null;
    }
    render(<Probe />);
    return { renders: () => renders, requests: () => requests };
  }

  it('does not re-render when only the cursor moves over the same entity', () => {
    act(() => useViewerStore.getState().setHoverState({ entityId: 5, screenX: 1, screenY: 1 }));
    const probe = mount();
    const before = probe.renders();
    act(() => useViewerStore.getState().setHoverState({ entityId: 5, screenX: 40, screenY: 60 }));
    act(() => useViewerStore.getState().setHoverState({ entityId: 5, screenX: 80, screenY: 90 }));
    assert.equal(probe.renders(), before);
  });

  it('re-renders and requests a frame when the hovered entity changes', () => {
    const probe = mount();
    const renders = probe.renders();
    const requests = probe.requests();
    act(() => useViewerStore.getState().setHoverState({ entityId: 9, screenX: 1, screenY: 1 }));
    assert.equal(probe.renders(), renders + 1);
    assert.equal(probe.requests(), requests + 1, 'an idle view must redraw to show the new outline');
  });
});
