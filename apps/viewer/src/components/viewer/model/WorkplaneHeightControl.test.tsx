/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9202: the height control. The chip on the 3D HUD and the plan header show
 * and set one number, the session plane's offset, and what a running command
 * draws on moves with it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { cleanup, click, press, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { CommandContext } from '@/lib/commands/modeling/types';
import '@/lib/commands/modeling/builtin';
import { ViewportHud } from '../../viewport-ui/hud';
import { PlanWorkplaneHeight, WorkplaneHeightChip } from './WorkplaneHeightControl';

const state = () => useViewerStore.getState();
const offset = () => {
  const plane = state().session?.workplane;
  return plane?.kind === 'storey' ? plane.offset : null;
};

function mount() {
  return render(
    <TooltipProvider>
      <ViewportHud />
      <WorkplaneHeightChip />
      <PlanWorkplaneHeight />
    </TooltipProvider>,
  );
}
const chip = (ui: HTMLElement) => ui.querySelector('[data-workplane-height]') as HTMLButtonElement;
const planButton = (ui: HTMLElement) => ui.querySelector('[data-plan-height]') as HTMLButtonElement;
const picker = () => document.body.querySelector('[data-workplane-height-picker]') as HTMLElement | null;
const open = (trigger: HTMLElement) => act(() => {
  trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  click(trigger);
});

beforeEach(async () => {
  await seedModelingSession();
  state().enterModelWorkspace();
});
afterEach(() => {
  state().exitModelWorkspace();
  cleanup();
});

describe('the height control (#9202)', () => {
  it('shows nothing without a plane, and the floor once there is one', () => {
    act(() => { state().exitModelWorkspace(); });
    const ui = mount();
    assert.equal(chip(ui), null);
    act(() => { state().enterModelWorkspace(); });
    assert.match(chip(ui).textContent ?? '', /Plane ±0\.00 m/);
    assert.match(planButton(ui).textContent ?? '', /Plane ±0\.00 m/);
  });

  it('3D and the plan read the same height, whichever side set it', () => {
    const ui = mount();
    act(() => { state().setWorkplane({ kind: 'storey', storeyId: STOREY, offset: 2.5 }); });
    assert.match(chip(ui).textContent ?? '', /Plane \+2\.50 m/);
    assert.match(planButton(ui).textContent ?? '', /Plane \+2\.50 m/);
  });

  it('Top of walls takes the height the walls reach, and Floor goes back', () => {
    state().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3.2 });
    const ui = mount();
    open(planButton(ui));
    const top = picker()?.querySelector('[data-workplane-height-preset="top-of-walls"]') as HTMLButtonElement;
    assert.match(top.textContent ?? '', /Top of walls \+3\.20 m/);
    click(top);
    assert.ok(Math.abs(offset()! - 3.2) < 1e-9);
    click(picker()!.querySelector('[data-workplane-height-preset="floor"]') as HTMLButtonElement);
    assert.equal(offset(), 0);
    assert.equal(state().session?.planeHeightPinned, false, 'Floor hands the height back to the Roof tool');
  });

  it('walls that top out below the floor give Top of walls and Roof that height', () => {
    state().addWall(MODEL_ID, STOREY, { Start: [0, 0, -2], End: [4, 0, -2], Thickness: 0.2, Height: 1 });
    const ui = mount();
    open(planButton(ui));
    const top = picker()?.querySelector('[data-workplane-height-preset="top-of-walls"]') as HTMLButtonElement | null;
    assert.ok(top, 'offered below the floor too');
    assert.match(top.textContent ?? '', /Top of walls −1\.00 m/);
    act(() => {
      state().setAuthoringDefaults({ slabClass: 'roof' });
      state().startCommand('slab.place');
    });
    assert.ok(Math.abs(offset()! + 1) < 1e-9, 'Roof takes the unpinned plane down to the wall top');
  });

  it('a typed height reaches the running command', () => {
    const ui = mount();
    act(() => { state().startCommand('wall.place'); });
    open(chip(ui));
    const field = picker()!.querySelector('[role="spinbutton"]') as HTMLElement;
    assert.equal(field.getAttribute('aria-label'), 'Plane height');
    press(field, 'Enter');
    const input = picker()!.querySelector('input') as HTMLInputElement;
    type(input, '6.5');
    press(input, 'Enter');
    assert.equal(offset(), 6.5);
    const spec = (getCommandRuntime().ctx as CommandContext).workplane?.spec;
    assert.deepEqual(spec, { kind: 'storey', storeyId: STOREY, offset: 6.5 });
  });
});
