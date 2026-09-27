/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5957: the host measures the toolbar bottom (the viewport region's top,
 * `[data-floating-snap-bounds]`) and a free panel saved above it is drawn
 * below it, title bar reachable, instead of at `top: 0` under the z-50
 * toolbar.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { FloatingPanelHost } from './FloatingPanelHost';

const TOOLBAR_BOTTOM = 48;

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-floating-snap-bounds]').forEach((el) => el.remove());
  useViewerStore.setState({ floatingPanels: [] });
});

it('draws a free panel saved above the window below the toolbar (#5957)', async () => {
  const region = document.createElement('div');
  region.setAttribute('data-floating-snap-bounds', '');
  region.getBoundingClientRect = () =>
    ({ top: TOOLBAR_BOTTOM, left: 0, right: 1024, bottom: 768, width: 1024, height: 768 - TOOLBAR_BOTTOM, x: 0, y: TOOLBAR_BOTTOM, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(region);

  useViewerStore.setState({
    floatingPanels: [{ id: 'measurements', snap: 'free', x: 100, y: -40, w: 320, h: 240 }],
  });
  const ui = render(<FloatingPanelHost />);
  await act(async () => {});

  const panel = ui.querySelector('.pointer-events-auto') as HTMLElement | null;
  assert.ok(panel, 'the floating panel is drawn');
  assert.equal(panel.style.top, `${TOOLBAR_BOTTOM}px`, 'the title bar sits at the toolbar bottom, not under it');
});
