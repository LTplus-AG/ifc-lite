/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { activate, cleanup, click, press, render } from '@/test/render';
import { useViewerStore, type RibbonTabId } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { KEY_COMMANDS } from '@/lib/commands/keyboard-commands';
import { RibbonToolbar } from './RibbonToolbar';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
function Keys() { useKeyboardShortcuts(); return null; }
for (const tab of ['home', 'view', 'file', 'elements', 'analyze', 'author'] satisfies RibbonTabId[]) {
  it(`Model is persistent on ${tab}; M and the button agree (#9296)`, async () => {
    await seedModelingSession();
    useViewerStore.setState({ ribbonTab: tab, workspaceMode: 'view', session: null });
    const ui = render(<><RibbonToolbar /><Keys /></>);
    const buttons = ui.querySelectorAll<HTMLButtonElement>('[data-command-id="tool:edit-mode"]');
    assert.equal(buttons.length, 1);
    const button = buttons[0];
    assert.equal(button.closest('[role="tabpanel"]') === null, true, 'Model belongs to the tab row');
    click(button);
    assert.equal(useViewerStore.getState().workspaceMode, 'model');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    press(document.body, 'm');
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    press(document.body, 'e');
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
  });
}

// #9296 review: keyboard entry keeps focus on the button, so Enter again leaves.
it('Enter on Model enters and leaves with focus kept on the button (#9296)', async () => {
  await seedModelingSession();
  useViewerStore.setState({ ribbonTab: 'home', workspaceMode: 'view', session: null });
  const ui = render(<><RibbonToolbar /><Keys /></>);
  const button = ui.querySelector<HTMLButtonElement>('[data-command-id="tool:edit-mode"]')!;
  activate(button, 'Enter');
  assert.equal(useViewerStore.getState().workspaceMode, 'model');
  assert.equal(document.activeElement === button, true, 'focus stays on Model after entering');
  activate(button, ' ');
  assert.equal(useViewerStore.getState().workspaceMode, 'view');
  assert.equal(document.activeElement === button, true, 'focus stays on Model after leaving');
});

// #9296 review: Move owns Shift+M inside Model, so Measure needs its own key.
it('the Measure key starts Measure in View and inside Model (#9296)', async () => {
  await seedModelingSession();
  useViewerStore.setState({ ribbonTab: 'home', workspaceMode: 'view', session: null, activeTool: 'select' });
  render(<><RibbonToolbar /><Keys /></>);
  const [measureKey] = KEY_COMMANDS.find((c) => c.id === 'tool.measure')!.keys;
  const pressMeasure = () => press(document.body, measureKey.key, { shiftKey: measureKey.shift === true });
  pressMeasure();
  assert.equal(useViewerStore.getState().activeTool, 'measure');
  useViewerStore.getState().setActiveTool('select');
  assert.ok(useViewerStore.getState().enterModelWorkspace());
  pressMeasure();
  assert.equal(useViewerStore.getState().workspaceMode, 'model');
  assert.equal(useViewerStore.getState().activeTool, 'measure');
  assert.equal(useViewerStore.getState().session?.activeCommandId ?? null, null, 'no modeling command started');
});

// #9296 review: a view-only role sees why Model is unavailable.
it('Model explains itself when the role cannot edit (#9296)', async () => {
  await seedModelingSession();
  useViewerStore.setState({ ribbonTab: 'home', workspaceMode: 'view', session: null, collabRole: 'viewer' });
  const ui = render(<RibbonToolbar />);
  const button = ui.querySelector<HTMLButtonElement>('[data-command-id="tool:edit-mode"]')!;
  assert.equal(button.disabled, false, 'reachable by pointer and focus');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  click(button);
  assert.equal(useViewerStore.getState().workspaceMode, 'view');
  act(() => button.focus());
  const tooltip = document.body.querySelector('[role="tooltip"]');
  assert.match(tooltip?.textContent ?? '', /requires editor access/);
});
