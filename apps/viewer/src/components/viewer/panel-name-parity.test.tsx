/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { registerLocale, setLocale } from '@/i18n';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { cleanup, render, type as typeInto } from '@/test/render.js';
import { ActivityBar } from './sidebar/ActivityBar.js';
import { AnalyzeTab } from './ribbon/tabs/AnalyzeTab.js';
import { CommandPalette } from './CommandPalette.js';
import { MainToolbar } from './MainToolbar.js';

const TITLE = 'Unified validation panel';

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ sidebarHiddenIds: [], sidebarCustomizing: false, floatingPanels: [], poppedOutIds: [] });
});

describe('workspace panel name parity (#5858)', () => {
  it('renders the same localized validation name in the rail, ribbon, palette, and classic toolbar', () => {
    registerLocale('panel-name-parity-5858', { 'validationPanel.title': TITLE });
    setLocale('panel-name-parity-5858');
    useViewerStore.setState({
      sidebarOrder: WORKSPACE_PANELS.map((panel) => panel.id),
      sidebarHiddenIds: [],
      sidebarCustomizing: false,
      sidebarMode: 'expanded',
      sidebarActivePanel: 'properties',
      floatingPanels: [],
      poppedOutIds: [],
    });

    render(<ActivityBar />);
    assert.ok(document.querySelector(`button[aria-label="${TITLE}"]`), 'rail uses the panel title');
    cleanup();

    const ribbon = render(<AnalyzeTab />);
    const ribbonButton = [...ribbon.querySelectorAll('button')].find((button) => button.textContent?.includes(TITLE));
    assert.ok(ribbonButton, 'ribbon uses the panel title');
    assert.equal(ribbonButton.getAttribute('aria-label'), TITLE, 'ribbon announces the panel title, not its descriptive tooltip');
    const descriptionId = ribbonButton.getAttribute('aria-describedby');
    assert.ok(descriptionId, 'ribbon button links its descriptive tooltip');
    assert.equal(document.getElementById(descriptionId)?.textContent, 'IDS validation');
    cleanup();

    render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>,
    );
    const search = document.querySelector('input') as HTMLInputElement;
    assert.ok(search, 'palette search is mounted');
    typeInto(search, TITLE);
    assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(TITLE)), 'palette uses the panel title');
    typeInto(search, 'IDS Validation');
    assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(TITLE)), 'the former palette name still finds the panel');
    typeInto(search, 'Construction Schedule (Gantt)');
    assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes('Schedule (Gantt)')), 'the former schedule name still finds the panel');
    typeInto(search, 'Drawing (2D)');
    assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes('Drawing')), 'the former drawing name still finds the panel');
    cleanup();

    const classic = render(<MainToolbar />);
    const panels = [...classic.querySelectorAll('button[aria-haspopup="menu"]')].find((button) => button.getAttribute('aria-label')?.startsWith('Panels'));
    assert.ok(panels, 'classic Panels menu is mounted');
    act(() => panels.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => panels.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.ok([...document.querySelectorAll('[role="menuitemcheckbox"]')].some((item) => item.textContent?.trim() === TITLE), 'classic menu uses the panel title');
  });
});
