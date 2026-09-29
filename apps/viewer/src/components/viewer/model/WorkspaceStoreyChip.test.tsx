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
import { cleanup, click, render } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { ViewportHud } from '../../viewport-ui/hud';
import { WorkspaceStoreyChip } from './WorkspaceStoreyChip';

const topLeft = () => document.querySelector('[data-hud-region="top-left"]');
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
  render(<><ViewportHud /><WorkspaceStoreyChip /></>);
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Workspace storey chip (#6232 M2.1)', () => {
  it('names the session storey and its elevation, only while the workspace is open', () => {
    assert.equal(chipButton(), null);
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: UPPER_STOREY }); });
    assert.match(topLeft()?.textContent ?? '', /L1\+3\.00 m/);
    act(() => { useViewerStore.getState().exitModelWorkspace(); });
    assert.equal(chipButton(), null);
  });

  it('lists the storeys highest first, marks the current one, and a pick relaunches the command on that plane', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY, command: 'wall.place' }); });
    const rows = openList();
    assert.deepEqual(rows.map((r) => r.textContent), ['L1+3.00 m', 'L0±0.00 m']);
    assert.equal(rows[1].getAttribute('aria-current'), 'true');
    act(() => click(rows[0]));
    const s = useViewerStore.getState();
    assert.equal(s.session?.storeyId, UPPER_STOREY);
    assert.equal(getCommandRuntime().command?.id, 'wall.place', 'the command keeps running');
    assert.equal(getCommandRuntime().ctx?.storeyId, UPPER_STOREY, '…on the new storey');
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
