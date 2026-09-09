/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { AuthorTab } from '../ribbon/tabs/AuthorTab.js';
import { MainToolbar } from '../MainToolbar.js';
import { CommandPalette } from '../CommandPalette.js';
import { BimProvider } from '@/sdk/BimProvider';

function control(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('[aria-label], [role="menuitemcheckbox"]')]
    .find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
  assert.ok(found, `Expected visible ${label} control`);
  return found;
}
describe('appearance entry points #4243', () => {
  beforeEach(() => useViewerStore.setState({ sidebarActivePanel: 'properties', rightPanelCollapsed: false,
    floatingPanels: [], poppedOutIds: [], activeModelId: null, models: new Map() }));
  afterEach(cleanup);

  it('opens and closes the same workspace from the Author ribbon', () => {
    render(<AuthorTab />);
    click(control('Appearance'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'appearance');
    click(control('Appearance'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');
  });
  it('opens the workspace from the classic toolbar', () => {
    render(<MainToolbar />);
    const trigger = control('Panels');
    act(() => { trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); });
    click(trigger);
    click(control('Appearance'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'appearance');
  });
  it('opens the workspace from the command palette', async () => {
    render(<BimProvider><CommandPalette open onOpenChange={() => {}} /></BimProvider>);
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(element => element.textContent?.trim() === 'Appearance');
    assert.ok(row, 'The palette must expose Appearance');
    click(row);
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'appearance');
  });
});
