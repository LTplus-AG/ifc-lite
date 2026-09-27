/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, press, render } from '@/test/render.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useViewerStore } from '@/store';
import { RepositionRuntimeHost } from './RepositionRuntimeHost.js';

const originalState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

it('#5841 Reposition Escape closes its active session before a persisted drawing selection', () => {
  useViewerStore.setState({ repositionOpen: true, activeTool: 'select' });
  let drawingEscapes = 0;
  const unregisterDrawing = registerKeyboardCommand('drawing2d.cancel', () => { drawingEscapes++; });
  try {
    render(<RepositionRuntimeHost />);
    press(window, 'Escape');
    assert.equal(useViewerStore.getState().repositionOpen, false);
    assert.equal(drawingEscapes, 0, 'the background drawing selection remains untouched');
  } finally {
    unregisterDrawing();
  }
});
