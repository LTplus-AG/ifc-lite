/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Add Element panel's wall type runs the `wall.place` command (#6232):
 * picking Wall starts it, the panel stays open while it draws, another type
 * hands the canvas back to the add-element tool, and a wall click no longer
 * reaches the add-element drop handler.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { selectAddElementPanelOpen, useWallPlaceBridge } from './add-element-wall-command.js';

function Harness() {
  useWallPlaceBridge();
  return null;
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ addElementType: 'wall', addElementModelId: MODEL_ID, addElementStoreyId: null });
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('Add Element wall type → wall.place (#6232 WP2)', () => {
  it('Wall starts the command, the panel stays open, another type returns to the add-element tool', () => {
    act(() => useViewerStore.getState().setActiveTool('addElement'));
    render(<Harness />);
    let s = useViewerStore.getState();
    assert.equal(s.activeTool, 'command');
    assert.equal(s.session?.activeCommandId, 'wall.place');
    assert.equal(selectAddElementPanelOpen(s), true, 'the panel stays open while walls are drawn');

    act(() => useViewerStore.getState().setAddElementType('column'));
    s = useViewerStore.getState();
    assert.equal(s.activeTool, 'addElement');
    assert.equal(s.session?.activeCommandId ?? null, null);
    assert.equal(selectAddElementPanelOpen(s), true);

    act(() => useViewerStore.getState().setAddElementType('wall'));
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'wall.place');
    act(() => useViewerStore.getState().setActiveTool('select'));
    assert.equal(selectAddElementPanelOpen(useViewerStore.getState()), false, 'leaving the tool closes the panel');
  });
});
