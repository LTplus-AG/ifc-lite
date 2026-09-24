/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';

it('the real viewer store keeps the Sheet inspector and legacy panel visibility in sync (#5495)', () => {
  useViewerStore.setState({ drawingInspectorTab: null, sheetPanelVisible: false });

  useViewerStore.getState().toggleDrawingInspectorTab('sheet');
  assert.strictEqual(useViewerStore.getState().drawingInspectorTab, 'sheet');
  assert.strictEqual(useViewerStore.getState().sheetPanelVisible, true);

  useViewerStore.setState({ sheetPanelVisible: false });
  assert.strictEqual(useViewerStore.getState().drawingInspectorTab, null);
});
