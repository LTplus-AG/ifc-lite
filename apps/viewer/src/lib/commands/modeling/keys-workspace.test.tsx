/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `workspace.model` keys (charter #6232, M2.1): W draws walls only in the
 * Model workspace and not while walking; PageUp / PageDown step the session
 * through the storeys and stop at either end.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup, press, render } from '@/test/render.js';
import { STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from './runtime.js';

function Keys() { useKeyboardShortcuts(); return null; }

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, selectedEntityId: null });
  render(<Keys />);
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Model workspace keys (#6232 M2.1)', () => {
  it('W starts wall.place in the workspace, and does nothing outside it', () => {
    press(document.body, 'w');
    assert.equal(useViewerStore.getState().workspaceMode, 'view', 'W does not open the workspace');
    assert.equal(getCommandRuntime().command, null);

    useViewerStore.getState().enterModelWorkspace();
    press(document.body, 'w');
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'wall.place');
    assert.equal(getCommandRuntime().command?.id, 'wall.place');
  });

  // #6232 M2.2: Shift + the class initial, so S stays snap and C / B stay free.
  it('Shift+S, Shift+C and Shift+B start slab, column and beam in the workspace only', () => {
    press(document.body, 'S', { shiftKey: true });
    assert.equal(getCommandRuntime().command, null, 'nothing outside the workspace');
    useViewerStore.getState().enterModelWorkspace();
    for (const [key, id] of [['S', 'slab.place'], ['C', 'column.place'], ['B', 'beam.place']] as const) {
      press(document.body, key, { shiftKey: true });
      assert.equal(useViewerStore.getState().session?.activeCommandId, id, `Shift+${key}`);
      assert.equal(getCommandRuntime().command?.id, id);
    }
    press(document.body, 's');
    assert.equal(getCommandRuntime().command?.id, 'beam.place', 'plain S is the running command\'s snap toggle, not Slab');
  });

  it('walking keeps W for moving forward', () => {
    useViewerStore.getState().enterModelWorkspace();
    useViewerStore.getState().setActiveTool('walk');
    press(document.body, 'w');
    assert.equal(useViewerStore.getState().activeTool, 'walk');
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null);
  });

  it('PageUp / PageDown step through the storeys and stop at the ends', () => {
    useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
    press(document.body, 'PageDown');
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY, 'already the lowest');
    press(document.body, 'PageUp');
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY);
    assert.deepEqual(useViewerStore.getState().session?.workplane, { kind: 'storey', storeyId: UPPER_STOREY, offset: 0 });
    press(document.body, 'PageUp');
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY, 'already the highest');
    press(document.body, 'PageDown');
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
  });

  it('a storey step relaunches the running command on the new plane', () => {
    useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY, command: 'wall.place' });
    assert.equal(getCommandRuntime().ctx?.storeyId, STOREY);
    press(document.body, 'PageUp');
    assert.equal(getCommandRuntime().command?.id, 'wall.place');
    assert.equal(getCommandRuntime().ctx?.storeyId, UPPER_STOREY);
  });
});
