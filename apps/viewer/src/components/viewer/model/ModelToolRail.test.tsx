/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model tool rail (charter #6232, M2.1): only in the workspace; Wall
 * starts `wall.place` without reopening the Add Element panel; a tool that
 * cannot start is disabled with its reason; Leave leaves.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';
import { selectAddElementPanelOpen } from '../add-element-wall-command';
import { TOOL_SURFACE_COMMANDS } from '../surface-commands-tools';
import { ModelToolRail } from './ModelToolRail';

const tool = (root: HTMLElement, id: string) => root.querySelector(`[data-rail-tool="${id}"]`) as HTMLButtonElement | null;

function mount(): HTMLElement {
  return render(<TooltipProvider><ModelToolRail /></TooltipProvider>);
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, selectedEntityId: null, addElementDrawsWall: false });
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Model tool rail (#6232 M2.1)', () => {
  it('shows only while the workspace is open, with Select, Wall, Split, the plan toggle (M2.4) and Leave', () => {
    const ui = mount();
    assert.equal(ui.querySelector('[data-model-tool-rail]'), null, 'no rail while viewing');
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    const ids = [...ui.querySelectorAll('[data-rail-tool]')].map((b) => b.getAttribute('data-rail-tool'));
    assert.deepEqual(ids, ['select', 'wall.place', 'element.split', 'plan', 'leave']);
    assert.equal(tool(ui, 'select')?.getAttribute('aria-pressed'), 'true');
  });

  it('Wall starts wall.place on the session storey, and the Add Element panel stays shut', () => {
    // A stale panel launch must not make the rail's wall reopen the panel.
    useViewerStore.setState({ addElementDrawsWall: true });
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => click(tool(ui, 'wall.place')!));
    const s = useViewerStore.getState();
    assert.equal(s.session?.activeCommandId, 'wall.place');
    assert.equal(s.session?.storeyId, STOREY);
    assert.equal(selectAddElementPanelOpen(s), false);
    assert.equal(tool(ui, 'wall.place')?.getAttribute('aria-pressed'), 'true');
    act(() => click(tool(ui, 'select')!));
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null, 'Select ends the command');
  });

  it('Split is disabled with its reason until something is selected', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    assert.equal(tool(ui, 'element.split')?.disabled, true);
    assert.ok(ui.querySelector('[data-rail-disabled="element.split"]'), 'a live tooltip trigger wraps the disabled button');
    act(() => {
      const s = useViewerStore.getState();
      s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, STOREY));
    });
    assert.equal(tool(ui, 'element.split')?.disabled, false);
  });

  it('with no storey to draw on, Wall is disabled and refuses to start', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => {
      const session = useViewerStore.getState().session!;
      useViewerStore.setState({ session: { ...session, storeyId: null, workplane: null } });
    });
    assert.equal(tool(ui, 'wall.place')?.disabled, true);
    assert.equal(tool(ui, 'select')?.disabled, false, 'Select never needs a plane');
    assert.ok(ui.querySelector('[data-rail-disabled="wall.place"]'));
    act(() => { assert.equal(launchModelCommand('wall.place'), false, 'W and the palette are refused too'); });
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null);
  });

  it("the palette's Draw walls enters the workspace and runs the rail's Wall", () => {
    const row = TOOL_SURFACE_COMMANDS.find((command) => command.id === 'tool:wall');
    assert.equal(row?.shortcut, 'model.wall', 'the palette names the rail key');
    act(() => { row!.run(); });
    const s = useViewerStore.getState();
    assert.equal(s.workspaceMode, 'model');
    assert.equal(s.session?.activeCommandId, 'wall.place');
  });

  it('Leave closes the workspace, and the rail with it', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => click(tool(ui, 'leave')!));
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(ui.querySelector('[data-model-tool-rail]'), null);
  });
});
