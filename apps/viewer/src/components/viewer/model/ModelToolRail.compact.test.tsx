/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { advance, cleanup, click, press, render } from '@/test/render.js';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { ModelToolRail } from './ModelToolRail';
import { RAIL_TOOLS } from './rail-tools';

// happy-dom has no layout. Supply measured button/footer boxes and a resizable
// rail; commands, focus, menu events and the parsed IFC fixture remain real.
let height = 600;
const observers = new Set<MeasuredResizeObserver>();
class MeasuredResizeObserver implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe() {}
  unobserve() {}
  disconnect() { observers.delete(this); }
}
const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
const originalObserver = globalThis.ResizeObserver;
function resize(next: number) {
  height = next;
  act(() => { for (const observer of observers) observer.callback([], observer); });
}
function group(ui: HTMLElement, id: string): HTMLButtonElement {
  const button = ui.querySelector<HTMLButtonElement>(`[data-rail-group="${id}"]`);
  assert.ok(button, `${id} menu remains reachable`);
  return button;
}
async function open(ui: HTMLElement, id: string) {
  const button = group(ui, id);
  act(() => button.focus());
  press(button, 'ArrowDown');
  await advance(20);
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, 'keyboard opens the real portaled menu');
  return menu;
}

beforeEach(async () => {
  height = 600;
  globalThis.ResizeObserver = MeasuredResizeObserver;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const measured = this.hasAttribute('data-model-tool-rail') ? height
      : this.hasAttribute('data-rail-footer') ? 124
      : this.hasAttribute('data-rail-divider') ? 1
      : this.tagName === 'BUTTON' ? 36 : 0;
    return new DOMRect(0, 0, 48, measured);
  };
  await seedModelingSession();
  act(() => { useViewerStore.getState().enterModelWorkspace(); });
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalObserver;
  observers.clear();
});

describe('Model rail fits its measured viewport (#6232 compact rail)', () => {
  it('groups an overflowing rail and retains Select and every footer action', async () => {
    const ui = render(<ModelToolRail />);
    assert.equal(ui.querySelector('nav')?.getAttribute('data-rail-layout'), 'grouped');
    assert.equal(ui.querySelectorAll('[data-rail-group]').length, 4);
    for (const id of ['select', 'change-sets', 'plan', 'leave']) assert.ok(ui.querySelector(`[data-rail-tool="${id}"]`));
    const found: string[] = ['select'];
    for (const id of ['build', 'host', 'edit', 'circulation']) {
      const menu = await open(ui, id);
      found.push(...[...menu.querySelectorAll('[data-rail-menu-tool]')].map((item) => item.getAttribute('data-rail-menu-tool')!));
      press(menu, 'Escape');
      await advance(20);
    }
    assert.deepEqual(found.sort(), RAIL_TOOLS.map((tool) => tool.id).sort(), 'no command disappears or occurs twice');
    click(ui.querySelector('[data-rail-tool="leave"]')!);
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
  });

  it('a grouped build command starts the same session tool and shows its active state', async () => {
    const ui = render(<ModelToolRail />);
    const menu = await open(ui, 'build');
    const slab = menu.querySelector<HTMLElement>('[data-rail-menu-tool="slab.place"]');
    assert.ok(slab);
    press(slab, 'Enter');
    await advance(20);
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'slab.place');
    const reopened = await open(ui, 'build');
    assert.ok(reopened.querySelector('[data-rail-menu-tool="slab.place"] [aria-label="Active tool"]'));
    press(reopened, 'Escape');
    await advance(20);
    click(ui.querySelector('[data-rail-tool="select"]')!);
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null);
  });

  it('shows disabled tool reasons and refuses to launch without a workplane', async () => {
    const ui = render(<ModelToolRail />);
    act(() => {
      const session = useViewerStore.getState().session!;
      useViewerStore.setState({ session: { ...session, storeyId: null, workplane: null } });
    });
    const menu = await open(ui, 'host');
    const door = menu.querySelector<HTMLElement>('[data-rail-menu-tool="door.place"]');
    assert.ok(door);
    assert.equal(door.getAttribute('aria-disabled'), 'true');
    assert.match(door.textContent!, /storey/i);
    click(door);
    assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null);
  });

  it('Escape returns keyboard focus to the group without changing the active command', async () => {
    const ui = render(<ModelToolRail />);
    const before = useViewerStore.getState().session?.activeCommandId;
    const menu = await open(ui, 'edit');
    press(menu, 'Escape');
    await advance(20);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, group(ui, 'edit'));
    assert.equal(useViewerStore.getState().session?.activeCommandId, before);
  });

  it('restores direct commands when the viewport grows and groups them again when it shrinks', () => {
    const ui = render(<ModelToolRail />);
    resize(1100);
    assert.equal(ui.querySelector('nav')?.getAttribute('data-rail-layout'), 'full');
    assert.equal(ui.querySelectorAll('[data-rail-group]').length, 0);
    assert.equal(ui.querySelectorAll('[data-rail-tool]').length, RAIL_TOOLS.length + 3);
    resize(600);
    assert.equal(ui.querySelector('nav')?.getAttribute('data-rail-layout'), 'grouped');
    assert.equal(ui.querySelectorAll('[data-rail-group]').length, 4);
  });
});
