/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { registerLocale, setLocale, type TranslationKey } from '@/i18n';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { advance, cleanup, click, render, type as typeInto } from '@/test/render.js';
import { ActivityBar } from './sidebar/ActivityBar.js';
import { AnalyzeTab } from './ribbon/tabs/AnalyzeTab.js';
import { CommandPalette } from './CommandPalette.js';

const TITLE = 'Unified validation panel';

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ sidebarHiddenIds: [], sidebarCustomizing: false, floatingPanels: [], poppedOutIds: [], pointCloudAssetCount: 0 });
});

describe('workspace panel name parity (#5858)', () => {
  it('renders each available registry panel with the same name across rail and palette', async () => {
    const titles = new Map(WORKSPACE_PANELS.map(({ id }) => [id, `Canonical ${id} panel`]));
    const translations: Partial<Record<TranslationKey, string>> = {};
    for (const panel of WORKSPACE_PANELS) translations[panel.titleKey] = titles.get(panel.id);
    registerLocale('panel-name-matrix-5858', translations);
    setLocale('panel-name-matrix-5858');
    useViewerStore.setState({
      sidebarOrder: WORKSPACE_PANELS.map((panel) => panel.id),
      sidebarHiddenIds: [], sidebarCustomizing: false, sidebarMode: 'expanded',
      pointCloudAssetCount: 1, floatingPanels: [], poppedOutIds: [],
    });

    render(<ActivityBar />);
    for (const panel of WORKSPACE_PANELS) {
      // The Room rail entry is intentionally gated by the collaboration feature flag.
      if (panel.id === 'collab') continue;
      assert.ok(document.querySelector(`button[aria-label="${titles.get(panel.id)}"]`), `${panel.id} rail name`);
    }
    cleanup();

    render(<BimReactContext.Provider value={{} as BimContext}><CommandPalette open onOpenChange={() => {}} /></BimReactContext.Provider>);
    const search = document.querySelector('input') as HTMLInputElement;
    assert.ok(search, 'palette search is mounted');
    for (const panel of WORKSPACE_PANELS) {
      // Placement and Presentation have rail/ribbon entry points but no palette row.
      if (panel.id === 'collab' || panel.id === 'placement' || panel.id === 'presentation') continue;
      const title = titles.get(panel.id);
      assert.ok(title);
      typeInto(search, title);
      assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(title)), `${panel.id} palette name`);
    }
    const changesTitle = titles.get('changes');
    assert.ok(changesTitle);
    typeInto(search, changesTitle);
    const changesOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes(changesTitle));
    assert.ok(changesOption, 'Changes uses the canonical palette title');
    click(changesOption);
    await advance(25);
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'changes',
      'the palette command opens the Changes panel');
    cleanup();
  });

  it('renders the same localized validation name in the rail, ribbon and palette', () => {
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
  });
});
