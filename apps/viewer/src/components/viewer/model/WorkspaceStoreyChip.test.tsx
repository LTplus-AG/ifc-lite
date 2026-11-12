/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey chip (charter #6232, M2.1): it names the
 * session storey with its elevation, lists the storeys highest first with the
 * current one marked, moves the session (relaunching a running command on
 * the new plane), and isolates the storey through the one isolation channel.
 * It supersedes the "Editing · <model>" chip.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { advance, cleanup, click, render, waitFor } from '@/test/render.js';
import { requiredModule } from '@/i18n/__tests__/required-module';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { fixtureModels } from '@/test/store-fixture';
import type { SnapResult } from '@/lib/snap/types';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { StoreyPicker } from './StoreyPicker';
import { ViewportHud, HudPopover, HudPopoverTrigger, HudPopoverContent } from '../../viewport-ui/hud';
import { WorkspaceStoreyControl } from './WorkspaceStoreyChip';
import { Toaster } from '@/components/ui/toast';
import { commitStoreyOp } from '@/store/slices/mutation-storey';

const topLeft = () => document.querySelector('[data-workspace-storey-control]');
const chipButton = () => document.querySelector('[data-workspace-storey-chip]') as HTMLButtonElement | null;

function openList(): HTMLButtonElement[] {
  const trigger = chipButton()!;
  act(() => {
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    click(trigger);
  });
  return [...document.body.querySelectorAll('[data-storey-picker] button')] as HTMLButtonElement[];
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, selectedEntityId: null, levelDisplayMode: 'stacked', selectedStoreys: new Set() });
  render(<><ViewportHud /><WorkspaceStoreyControl /></>);
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Workspace storey chip (#6232 M2.1)', () => {
  it('#9334 the picker add toast cannot draw on a storey whose creation was undone', async () => {
    act(() => useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }));
    const notices = render(<Toaster />);
    for (const dismiss of notices.querySelectorAll('[aria-label="Dismiss notification"]')) click(dismiss);
    openList();
    click([...document.body.querySelectorAll('[data-storey-picker-actions] button')].find(button => button.textContent?.includes('Add storey above'))!);
    await import('./storeys/add-storey');
    await waitFor(() => modelStoreys(useViewerStore.getState(), MODEL_ID).length === 3 && [...notices.querySelectorAll('button')].some(button => button.textContent === 'Draw on'), 'the picker adds a storey and shows its action');
    const draw = [...notices.querySelectorAll('button')].find(button => button.textContent === 'Draw on')!;
    assert.ok(draw);
    act(() => useViewerStore.getState().undo(MODEL_ID));
    const plane = useViewerStore.getState().session!.workplane;
    click(draw);
    await requiredModule(() => import('./storeys/storey-toast-actions'), 'the clicked toast action loads (#9334)');
    await advance(0);
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
    assert.equal(useViewerStore.getState().session?.workplane, plane);
    assert.equal(draw.isConnected, false);
  });

  it('names the session storey and its elevation, only while the workspace is open', () => {
    assert.equal(chipButton(), null);
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: UPPER_STOREY }); });
    assert.match(topLeft()?.textContent ?? '', /L1\+3\.00 m/);
    act(() => { useViewerStore.getState().exitModelWorkspace(); });
    assert.equal(chipButton(), null);
  });

  it('Add storey above adds nothing once the session has moved to another model (#9037 review)', async () => {
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    const firstView = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] });
    const parsedSecond = useViewerStore.getState().models.get(MODEL_ID)!;
    const second = { ...parsedSecond, id: 'structural', name: 'Structural', idOffset: 1_000_000 };
    const secondView = new MutablePropertyView(second.ifcDataStore!.properties, second.id);
    act(() => {
      useViewerStore.setState({
        ...fixtureModels(first, second),
        mutationViews: new Map([[first.id, firstView], [second.id, secondView]]),
      });
      useViewerStore.getState().enterModelWorkspace({ modelId: first.id, storeyId: STOREY });
    });
    openList();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('[data-storey-picker-actions] button')]
      .find((b) => b.textContent?.includes('Add storey above'))!;
    const added = (view: MutablePropertyView) => view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCBUILDINGSTOREY').length;
    // The click starts the module load; the session moves to the other model before it resolves.
    act(() => {
      click(add);
      useViewerStore.getState().exitModelWorkspace();
      useViewerStore.getState().enterModelWorkspace({ modelId: second.id, storeyId: STOREY });
    });
    await import('./storeys/add-storey');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(added(firstView), 0, 'no storey was written to the model left behind');
    assert.equal(useViewerStore.getState().session?.modelId, second.id, 'the session stays on the model now open');
  });

  it('Add storey above from a session that has ended does nothing, even after re-entering the same model (#9037 review)', async () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    openList();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('[data-storey-picker-actions] button')]
      .find((b) => b.textContent?.includes('Add storey above'))!;
    const before = modelStoreys(useViewerStore.getState(), MODEL_ID).length;
    act(() => {
      click(add);
      useViewerStore.getState().exitModelWorkspace();
      useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
    });
    await import('./storeys/add-storey');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(modelStoreys(useViewerStore.getState(), MODEL_ID).length, before, 'the abandoned click added nothing');
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY, 'and the new session stays where it opened');
  });

  it('Add storey above goes above the topmost storey when the click resolves (#9037 review)', async () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    // #9334/#9389: 3.1 + 3.2 must be displayed as +6.30, never the float tail.
    act(() => {
      assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: STOREY, Elevation: -0.1 } }).ok);
      assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.1 } }).ok);
    });
    const notices = render(<Toaster />);
    for (const dismiss of notices.querySelectorAll('[aria-label="Dismiss notification"]')) click(dismiss);
    openList();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('[data-storey-picker-actions] button')]
      .find((b) => b.textContent?.includes('Add storey above'))!;
    // Clicked on L0; the session moves to L1 before the module load resolves.
    act(() => { click(add); useViewerStore.getState().setSessionStorey(UPPER_STOREY); });
    await import('./storeys/add-storey');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const created = useViewerStore.getState().session!.storeyId!;
    assert.equal(created, UPPER_STOREY, '#9296 adding keeps the active drawing storey');
    const elevations = new Map(modelStoreys(useViewerStore.getState(), MODEL_ID).map((st) => [st.expressId, st.elevation]));
    assert.ok(Math.max(...elevations.values()) > elevations.get(UPPER_STOREY)!, 'the new level sits above the reference');
    await waitFor(() => (notices.textContent ?? '').includes('added at'), 'the added-storey toast appears');
    assert.match(notices.textContent ?? '', /added at \+6\.30 m/, 'the toast uses the shared elevation format');
  });

  it('lists the storeys highest first, marks the current one, and a pick relaunches the command on that plane', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY, command: 'wall.place' }); });
    const rows = openList();
    assert.deepEqual(rows.map((r) => r.textContent), ['L1+3.00 m', 'L0±0.00 m']);
    assert.equal(rows[1].getAttribute('aria-current'), 'true');
    act(() => click(rows[0]));
    const s = useViewerStore.getState();
    // #9334: do not format a live happy-dom tree when the production revert leaves it open.
    assert.equal(document.querySelector('[data-storey-picker]') === null, true, '#9296 a pick dismisses the shortcut-blocking list');
    assert.equal(s.session?.storeyId, UPPER_STOREY);
    assert.equal(getCommandRuntime().command?.id, 'wall.place', 'the command keeps running');
    assert.equal(getCommandRuntime().ctx?.storeyId, UPPER_STOREY, '…on the new storey');
  });

  it('picking another parsed model targets new writes there, retaining the command and isolation (#6531)', async () => {
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    const firstView = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] });
    const parsedSecond = useViewerStore.getState().models.get(MODEL_ID)!;
    const second = { ...parsedSecond, id: 'structural', name: 'Structural', idOffset: 1_000_000 };
    const secondView = new MutablePropertyView(second.ifcDataStore!.properties, second.id);
    act(() => {
      useViewerStore.setState({
        ...fixtureModels(first, second),
        mutationViews: new Map([[first.id, firstView], [second.id, secondView]]),
      });
      useViewerStore.getState().enterModelWorkspace({ modelId: first.id, storeyId: STOREY, command: 'wall.place' });
    });
    const eye = topLeft()!.querySelector('button[aria-label="Show only this storey"]')!;
    act(() => click(eye));
    openList();
    const pick = document.querySelector('[data-storey-picker] ul[aria-label="Structural"] button')!;
    assert.ok(pick, 'both editable model groups are exposed by the existing picker');
    act(() => click(pick));
    assert.equal(getCommandRuntime().command?.id, 'wall.place');
    assert.equal(getCommandRuntime().ctx?.modelId, second.id);
    assert.equal(getCommandRuntime().ctx?.storeyId, UPPER_STOREY);
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set([toGlobalIdFromModels(useViewerStore.getState().models, second.id, UPPER_STOREY)]));
    const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, metresPerPixel: 0.02 });
    const restore = setRequestRemesh(() => {});
    try {
      act(() => { commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0)); });
      act(() => { commandPointerMove(at(4, 0)); commandPointerDown(at(4, 0)); });
      const written = secondView.getNewEntities().filter((entity) => entity.type === 'IfcWall');
      assert.equal(written.length, 1, 'the real command writes a wall only to the chosen model');
      assert.equal(firstView.getNewEntities().length, 0, 'the first model stays untouched');
      // One undo step: the wall and its recorded top (#9013) share one batch.
      const stack = useViewerStore.getState().undoStacks.get(second.id) ?? [];
      const tags = stack.map((mutation) => useViewerStore.getState().mutationBatchTags.get(mutation.id));
      assert.ok(stack.length > 1 && tags.every((tag) => tag !== undefined), 'every record of the wall carries a batch tag');
      assert.equal(new Set(tags).size, 1);
      act(() => { useViewerStore.getState().undo(second.id); });
      assert.equal(secondView.getNewEntities().filter((entity) => entity.type === 'IfcWall').length, 0);
    } finally {
      restore();
    }
  });

  it('the eye isolates the storey, follows a storey change, and shows all again', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    const eye = () => topLeft()!.querySelector('button[aria-label]:not([data-workspace-storey-chip]):not([data-storey-context])') as HTMLButtonElement;
    const soloOn = (storeyId: number) => {
      const s = useViewerStore.getState();
      return s.levelDisplayMode === 'solo' && s.selectedStoreys.has(toGlobalIdFromModels(s.models, MODEL_ID, storeyId));
    };
    assert.equal(eye().getAttribute('aria-label'), 'Show only this storey');
    act(() => click(eye()));
    assert.equal(soloOn(STOREY), true);
    const rows = openList();
    act(() => click(rows[0]));
    assert.equal(soloOn(UPPER_STOREY), true, 'isolation follows the session to the new storey');
    assert.equal(soloOn(STOREY), false);
    assert.equal(eye().getAttribute('aria-label'), 'Show all storeys');
    act(() => click(eye()));
    assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');
    assert.equal(useViewerStore.getState().selectedStoreys.size, 0);
  });

  it('the context control picks hide / ghost / show for the storeys above, remembered for the session (#6232 D9)', () => {
    act(() => { useViewerStore.getState().setStoreyContextMode('hide'); });
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    const control = () => topLeft()!.querySelector('[data-storey-context]') as HTMLButtonElement;
    assert.equal(control().getAttribute('aria-label'), 'Storeys above: hidden', 'hidden by default');
    act(() => {
      control().dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      click(control());
    });
    const options = [...document.body.querySelectorAll('[role="radiogroup"] [role="radio"]')] as HTMLButtonElement[];
    assert.deepEqual(options.map((o) => o.textContent), ['Hide above', 'Ghost above', 'Show all']);
    assert.equal(options[0].getAttribute('aria-checked'), 'true');
    act(() => click(options[1]));
    assert.equal(useViewerStore.getState().storeyContextMode, 'ghost');
    assert.equal(control().getAttribute('aria-label'), 'Storeys above: ghosted');
    assert.equal(window.sessionStorage.getItem('ifc-lite:model-workspace:storey-context'), 'ghost', 'kept for the browser session');
    act(() => click(options[2]));
    assert.equal(useViewerStore.getState().storeyContextMode, 'all');
    act(() => { useViewerStore.getState().setStoreyContextMode('hide'); });
  });

  it('a model without a storey reads "No storey" and raises a notice', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    act(() => {
      const session = useViewerStore.getState().session!;
      useViewerStore.setState({ session: { ...session, storeyId: null, workplane: null } });
    });
    assert.match(chipButton()?.textContent ?? '', /No storey/);
    assert.match(document.querySelector('[data-hud-region="top-center"]')?.textContent ?? '', /No storey to draw on/);
  });
});

it('#9334 the chip disables copy to storeys in a read-only model session', () => {
  act(() => { useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY }); });
  openList();
  const copy = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy to storeys…')!;
  assert.ok(copy);
  assert.equal(copy.disabled, false);
  act(() => { useViewerStore.setState({ editEnabled: false }); });
  assert.equal(copy.disabled, true);
  assert.match(copy.title, /Copying is unavailable/);
});

it('#9296 the shared picker dismisses an uncontrolled popover, as used by the plan header', () => {
  const groups = [{ modelId: MODEL_ID, modelName: 'Model', storeys: modelStoreys(useViewerStore.getState(), MODEL_ID) }];
  render(<HudPopover defaultOpen>
    <HudPopoverTrigger>Storeys</HudPopoverTrigger>
    <HudPopoverContent><StoreyPicker groups={groups} current={null} onPick={() => {}} /></HudPopoverContent>
  </HudPopover>);
  const option = document.querySelector('[data-storey-picker] button');
  assert.ok(option);
  click(option);
  assert.equal(document.querySelector('[data-storey-picker]') === null, true, 'the picker closes its own popover without caller state');
});

it('#9334 completing a copy closes the flow and reopens the chip on its storey list', async () => {
  const restore = setRequestRemesh(() => {});
  try {
    act(() => { useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY }); });
    const s = useViewerStore.getState();
    const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
    assert.ok('expressId' in wall);
    act(() => s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, wall.expressId)));
    openList();
    const button = (name: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent === name)!;
    click(button('Copy to storeys…'));
    await waitFor(() => !!document.querySelector('[data-copy-to-storeys]'), 'the first-open copy UI loads');
    click(button('Select all storeys')); click(button('Prepare copies'));
    await waitFor(() => !!button('Copy now'), 'copy prepared');
    click(button('Copy now'));
    await waitFor(() => !document.querySelector('[data-copy-to-storeys]'), 'copy flow closed');
    assert.equal(openList().length, 2, 'the next chip opening shows its normal storey list');
  } finally { restore(); }
});
