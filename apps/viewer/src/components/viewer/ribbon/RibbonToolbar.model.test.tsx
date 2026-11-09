/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, press, render } from '@/test/render';
import { useViewerStore, type RibbonTabId } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
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
    assert.equal(button.closest('[role="tabpanel"]'), null);
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
