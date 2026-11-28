/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { useVisibilityState } from '@/hooks/useViewerSelectors';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { measureSnapOptions } from '../measurePick';
import { MeasureToolbar } from './MeasureToolbar';

afterEach(cleanup);

it('#11518 the Measure toggle reaches picking and restores the previous ghost exceptions', () => {
  const stored = new Set([7, 8]);
  useViewerStore.setState({ activeTool: 'measure', ghostExceptEntities: stored });
  let ghostedExcept: Set<number> | null = null;
  function Controls() {
    ghostedExcept = useVisibilityState().ghostExceptEntities;
    return <><ViewportHud /><MeasureToolbar /></>;
  }
  const ui = render(<Controls />);
  const button = [...ui.querySelectorAll('button')].find(item => item.textContent?.trim() === 'X-ray');
  assert.ok(button, 'Measure offers the X-ray toggle');
  const pick = () => measureSnapOptions({ snapEnabledRef: { current: true } }).screenCornerSnap;
  assert.deepEqual(pick(), { markers: true });
  assert.equal(ghostedExcept, stored);
  click(button);
  assert.deepEqual(pick(), { markers: true, ignoreOcclusion: true });
  assert.deepEqual(ghostedExcept, new Set());
  assert.equal(useViewerStore.getState().ghostExceptEntities, stored);
  act(() => useViewerStore.setState({ activeTool: 'select' }));
  assert.equal(ghostedExcept, stored);
  act(() => useViewerStore.setState({ activeTool: 'measure' }));
  assert.deepEqual(ghostedExcept, new Set());
  click(button);
  assert.deepEqual(pick(), { markers: true });
  assert.equal(ghostedExcept, stored);
});
