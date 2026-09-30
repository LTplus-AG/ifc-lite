/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model tool rail (charter #6232, M2.1): only in the workspace; Wall
 * starts `wall.place`; a tool that
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
import { TOOL_SURFACE_COMMANDS } from '../surface-commands-tools';
import { ModelToolRail } from './ModelToolRail';

const tool = (root: HTMLElement, id: string) => root.querySelector(`[data-rail-tool="${id}"]`) as HTMLButtonElement | null;

const BUILD_TOOLS = ['wall.place', 'slab.place', 'column.place', 'beam.place'] as const;

function mount(): HTMLElement {
  return render(<TooltipProvider><ModelToolRail /></TooltipProvider>);
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, selectedEntityId: null });
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Model tool rail (#6232 M2.1)', () => {
  it('shows only while the workspace is open, with Select, the build tools, Split, Array, Move, Rotate, Change sets (D4), the plan toggle (M2.4) and Leave', () => {
    const ui = mount();
    assert.equal(ui.querySelector('[data-model-tool-rail]'), null, 'no rail while viewing');
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    const ids = [...ui.querySelectorAll('[data-rail-tool]')].map((b) => b.getAttribute('data-rail-tool'));
    assert.deepEqual(ids, ['select', 'wall.place', 'slab.place', 'column.place', 'beam.place', 'room.place', 'opening.place', 'door.place', 'window.place', 'element.split', 'element.array', 'element.move', 'element.rotate', 'stair.place', 'railing.place', 'change-sets', 'plan', 'leave']);
    assert.equal(tool(ui, 'select')?.getAttribute('aria-pressed'), 'true');
  });

  it('#6232 D4 Change sets opens and closes the Change sets panel', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => click(tool(ui, 'change-sets')!));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'changeSets');
    assert.equal(tool(ui, 'change-sets')?.getAttribute('aria-pressed'), 'true');
    act(() => click(tool(ui, 'change-sets')!));
    assert.notEqual(useViewerStore.getState().sidebarActivePanel, 'changeSets');
  });

  it('Wall starts wall.place on the session storey', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => click(tool(ui, 'wall.place')!));
    const s = useViewerStore.getState();
    assert.equal(s.session?.activeCommandId, 'wall.place');
    assert.equal(s.session?.storeyId, STOREY);
    assert.equal(tool(ui, 'wall.place')?.getAttribute('aria-pressed'), 'true');
    act(() => click(tool(ui, 'select')!));
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null, 'Select ends the command');
  });

  it('Split and Array are disabled with their reason until something is selected', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    for (const id of ['element.split', 'element.array']) {
      assert.equal(tool(ui, id)?.disabled, true, id);
      assert.ok(ui.querySelector(`[data-rail-disabled="${id}"]`), `${id}: a live tooltip trigger wraps the disabled button`);
    }
    act(() => {
      const s = useViewerStore.getState();
      s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, STOREY));
    });
    assert.equal(tool(ui, 'element.split')?.disabled, false);
    assert.equal(tool(ui, 'element.array')?.disabled, false);
  });

  it('Move and Rotate are disabled until something is selected, then start on it (#6232 C2)', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    for (const id of ['element.move', 'element.rotate']) assert.equal(tool(ui, id)?.disabled, true, id);
    act(() => {
      const s = useViewerStore.getState();
      s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, STOREY));
    });
    for (const id of ['element.move', 'element.rotate']) {
      assert.equal(tool(ui, id)?.disabled, false, id);
      act(() => click(tool(ui, id)!));
      assert.equal(useViewerStore.getState().session?.activeCommandId, id);
    }
  });

  it('with no storey to draw on, every build tool is disabled and refuses to start', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => {
      const session = useViewerStore.getState().session!;
      useViewerStore.setState({ session: { ...session, storeyId: null, workplane: null } });
    });
    for (const id of BUILD_TOOLS) {
      assert.equal(tool(ui, id)?.disabled, true, id);
      assert.ok(ui.querySelector(`[data-rail-disabled="${id}"]`), `${id} keeps a tooltip with its reason`);
      act(() => { assert.equal(launchModelCommand(id), false, `${id}: its key and the palette are refused too`); });
    }
    assert.equal(tool(ui, 'select')?.disabled, false, 'Select never needs a plane');
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

  // #6232 M2.2: Slab, Column and Beam are rail commands like Wall.
  for (const [id, paletteId, shortcut] of [
    ['slab.place', 'tool:slab', 'model.slab'],
    ['column.place', 'tool:column', 'model.column'],
    ['beam.place', 'tool:beam', 'model.beam'],
    // #6232 A1: the hosted tools.
    ['opening.place', 'tool:opening', 'model.opening'],
    ['door.place', 'tool:door', 'model.door'],
    ['window.place', 'tool:window', 'model.window'],
  ] as const) {
    it(`${id}: the rail button and the palette row start it on the session storey`, () => {
      const ui = mount();
      act(() => { useViewerStore.getState().enterModelWorkspace(); });
      act(() => click(tool(ui, id)!));
      assert.equal(useViewerStore.getState().session?.activeCommandId, id);
      assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
      assert.equal(tool(ui, id)?.getAttribute('aria-pressed'), 'true');
      act(() => { useViewerStore.getState().exitModelWorkspace(); });

      // Narrowed to the fields this test reads: the palette rows are a union with differing `run` arities.
      const row = TOOL_SURFACE_COMMANDS.find((command) => command.id === paletteId) as { shortcut?: string; run: () => void } | undefined;
      assert.equal(row?.shortcut, shortcut, 'the palette names the rail key');
      act(() => { row!.run(); });
      assert.equal(useViewerStore.getState().workspaceMode, 'model');
      assert.equal(useViewerStore.getState().session?.activeCommandId, id);
    });
  }

  it('Leave closes the workspace, and the rail with it', () => {
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => click(tool(ui, 'leave')!));
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(ui.querySelector('[data-model-tool-rail]'), null);
  });
});
