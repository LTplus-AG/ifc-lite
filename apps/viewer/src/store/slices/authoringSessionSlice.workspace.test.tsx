/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model workspace entry / exit (charter #6232, WP2): edit mode is the
 * workspace — E, the ribbon's Model button and the status-bar chip all go
 * through `setEditEnabled`, which enters / leaves it. Entry honours the
 * collab gate and picks the storey (selection → Add Element panel → first);
 * exit cancels the gesture in progress and drops authoring state.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click, press, render } from '@/test/render.js';
import { MODEL_ID, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { StatusBarWorkspaceChip } from '@/components/viewer/StatusBarWorkspaceChip';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';

const at = (x: number, y: number) => ({ local: [x, y] as const, winner: null, guides: [], locked: false });
const wallCount = () => {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCWALL').length;
};

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, collabRole: null, selectedEntityId: null });
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('Model workspace entry / exit (#6232 WP2)', () => {
  it('edit mode on = the Model workspace on the selection\'s storey; off leaves it', () => {
    const s = useViewerStore.getState();
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, UPPER_STOREY));
    s.setEditEnabled(true);
    let now = useViewerStore.getState();
    assert.equal(now.workspaceMode, 'model');
    assert.equal(now.editEnabled, true);
    assert.equal(now.session?.storeyId, UPPER_STOREY, 'the selected storey, not the first');
    assert.equal(now.activeTool, 'select', 'entering opens no tool');
    now.toggleEditEnabled();
    now = useViewerStore.getState();
    assert.equal(now.workspaceMode, 'view');
    assert.equal(now.session, null);
    assert.equal(now.editEnabled, false);
  });

  it('a viewer in a shared session cannot enter', () => {
    useViewerStore.setState({ collabRole: 'viewer', canCollabEdit: () => false });
    useViewerStore.getState().setEditEnabled(true);
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(useViewerStore.getState().editEnabled, false);
    useViewerStore.setState({ collabRole: null, canCollabEdit: () => true });
  });

  it('an authoring tool enters the workspace', () => {
    useViewerStore.getState().setActiveTool('addElement');
    assert.equal(useViewerStore.getState().workspaceMode, 'model');
  });

  it('leaving cancels the gesture in progress: nothing half-drawn is written', () => {
    useViewerStore.getState().startCommand('wall.place');
    commandPointerMove(at(0, 0));
    commandPointerDown(at(0, 0));
    commandPointerMove(at(3, 0));
    assert.equal(useViewerStore.getState().session?.phase, 'gesture');
    useViewerStore.getState().setEditEnabled(false);
    const s = useViewerStore.getState();
    assert.equal(s.workspaceMode, 'view');
    assert.equal(s.activeTool, 'select');
    assert.equal(getCommandRuntime().command, null);
    assert.equal(wallCount(), 0);
  });

  it('E toggles the workspace; the status-bar chip names the storey and toggles it too', () => {
    function Keys() { useKeyboardShortcuts(); return null; }
    render(<Keys />);
    const ui = render(<StatusBarWorkspaceChip />);
    const chip = ui.querySelector('[data-workspace-chip]') as HTMLButtonElement;
    assert.equal(chip.getAttribute('aria-pressed'), 'false');
    press(document.body, 'e');
    assert.equal(useViewerStore.getState().workspaceMode, 'model');
    assert.equal(chip.getAttribute('aria-pressed'), 'true');
    assert.equal(chip.textContent, 'Model · L0', 'no selection: the first storey');
    act(() => click(chip));
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
  });
});
