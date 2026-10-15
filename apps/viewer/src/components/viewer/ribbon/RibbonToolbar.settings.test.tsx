/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { useViewerStore, type RibbonTabId } from '@/store';
import { RibbonToolbar } from './RibbonToolbar';
import { SettingsDialogHost } from '../settings/SettingsDialog';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

// #5857: the Settings entry must survive tab changes and ribbon collapse.
for (const tab of ['home', 'view', 'file', 'elements', 'analyze', 'author'] satisfies RibbonTabId[]) {
  for (const collapsed of [false, true]) {
    it(`opens Settings from ${tab} with the ribbon ${collapsed ? 'collapsed' : 'expanded'}`, () => {
      useViewerStore.setState({ ribbonTab: tab, ribbonCollapsed: collapsed });
      const toolbar = render(<><RibbonToolbar /><SettingsDialogHost /></>);
      const buttons = toolbar.querySelectorAll('[data-command-id="pref:settings"]');
      assert.equal(buttons.length, 1, 'one persistent Settings button');
      // Keep failures bounded: inspecting a DOM node also walks React's store-backed fibers.
      assert.ok(!buttons[0].closest('[role="tabpanel"]'), 'Settings is outside the collapsible band');
      click(buttons[0]);
      const dialog = document.querySelector('[data-settings-dialog]');
      assert.ok(dialog, 'the shared Settings dialog opens');
      assert.ok(dialog.querySelector('#settings-theme'));
    });
  }
}
