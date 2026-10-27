/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import GlobePlacementControl from './GlobePlacementControl.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('ifc-lite:cesium-globe-placement');
  useViewerStore.setState({ cesiumGlobePlacement: 'auto', cesiumGlobePlacementStatus: null });
});

it('choosing Exact sets and persists the globe placement the bridge reads', () => {
  useViewerStore.setState({ cesiumGlobePlacement: 'auto', cesiumGlobePlacementStatus: null });
  const ui = render(<GlobePlacementControl />);
  const exact = ui.querySelector<HTMLInputElement>('input[value="exact"]');
  assert.ok(exact);
  click(exact);
  assert.equal(useViewerStore.getState().cesiumGlobePlacement, 'exact');
  assert.equal(localStorage.getItem('ifc-lite:cesium-globe-placement'), 'exact');
});

it('reports what Auto resolved to and the anchor-error estimate in centimetres', () => {
  useViewerStore.setState({ cesiumGlobePlacement: 'auto', cesiumGlobePlacementStatus: { mode: 'exact', anchorErrorMetres: 0.034 } });
  const ui = render(<GlobePlacementControl />);
  const text = ui.textContent ?? '';
  assert.match(text, /Every vertex placed through the map projection\./);
  assert.match(text, /Anchor error estimate: 3\.4 cm/);
  act(() => useViewerStore.setState({ cesiumGlobePlacementStatus: { mode: 'anchor', anchorErrorMetres: 0.0021 } }));
  assert.match(ui.textContent ?? '', /Placed by one anchor point\..*Anchor error estimate: 0\.2 cm/);
});
