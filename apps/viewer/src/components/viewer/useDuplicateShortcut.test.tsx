/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: Ctrl/⌘+D is gated exactly like the context menu's Duplicate — Edit
 * mode, collab role, and a live mutation view, through one predicate. Before,
 * it only checked for a view: with Edit mode off it ran into the store's
 * refusal and surfaced it as a "Couldn't duplicate" error, and on a model
 * whose editable view did not exist yet it silently did nothing.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { Toaster } from '@/components/ui/toast';
import { cleanup, render } from '@/test/render.js';
import { toastsFrom } from '@/test/toasts';
import { dispatchKeyboardDown } from '@/lib/commands/dispatcher';
import { WALL, WALL_MODEL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';
import { useDuplicateShortcut } from './useDuplicateShortcut';

function Harness() {
  useDuplicateShortcut();
  return <Toaster />;
}

/** Press Ctrl+D; returns the toast text it produced. */
function pressDuplicate(): string {
  return toastsFrom(document.body, () => act(() => {
    dispatchKeyboardDown(new window.KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }));
  }));
}

const undoDepth = () => useViewerStore.getState().undoStacks.get(WALL_MODEL)?.length ?? 0;

describe('Ctrl/⌘+D duplicate gating (#6233)', () => {
  beforeEach(async () => {
    const { unit, scale } = WALL_UNITS[1];
    await seedRectangleWall(unit, scale);
    useViewerStore.setState({ selectedEntityId: WALL, collabRole: null });
    render(<Harness />);
  });
  afterEach(() => {
    cleanup();
    useViewerStore.setState({ collabRole: null });
  });

  it('with Edit mode off it duplicates nothing and says why', () => {
    useViewerStore.setState({ editEnabled: false });
    const shown = pressDuplicate();
    assert.equal(undoDepth(), 0);
    assert.match(shown, /Turn on Edit mode to change this model/);
    assert.doesNotMatch(shown, /Couldn't duplicate/);
  });

  it('as a collab viewer it duplicates nothing and says why', () => {
    useViewerStore.setState({ collabRole: 'viewer' });
    const shown = pressDuplicate();
    assert.equal(undoDepth(), 0);
    assert.match(shown, /Editing requires editor access/);
  });

  it('with Edit mode on it duplicates, creating the editable view on demand', () => {
    useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
    const shown = pressDuplicate();
    assert.match(shown, /Duplicated as #/);
    const state = useViewerStore.getState();
    const view = state.mutationViews.get(WALL_MODEL)!;
    const records = view.getNewEntities();
    const wall = records.find((record) => record.type === 'IfcWall');
    assert.ok(wall, 'the shortcut must create a real copied wall');
    assert.notEqual(wall.expressId, WALL);
    assert.ok(records.length > 1, 'placements and relationships must accompany the copied wall (#6232)');
    const history = state.undoStacks.get(WALL_MODEL)!;
    assert.ok(records.every((record) => history.some((mutation) => mutation.entityId === record.expressId)), 'all copied records participate in undo');
    assert.equal(new Set(history.map((mutation) => state.mutationBatchTags.get(mutation.id))).size, 1, 'one complete copy operation');
    act(() => useViewerStore.getState().undo(WALL_MODEL));
    assert.equal(view.getNewEntities().length, 0, 'one undo removes the wall and its complete copied graph');
    assert.equal(undoDepth(), 0);
  });
});
