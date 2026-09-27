/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, mouseDown, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry';
import { useViewerStore, type RibbonTabId } from '@/store';
import { SURFACE_COMMANDS, type SurfaceCommandDefinition } from '../surface-commands.js';
import { EXPORT_COMMANDS } from '../toolbar/export-commands.js';
import { RibbonToolbar } from './RibbonToolbar.js';

const TABS: RibbonTabId[] = ['file', 'home', 'view', 'elements', 'analyze', 'author'];
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState(initialState));
});

it('#5878 mounted ribbon commands use their registry names on every tab', () => {
  act(() => useViewerStore.setState({
    ribbonTab: 'home', ribbonCollapsed: false,
    selectedEntityId: 11, selectedEntityIds: new Set([11]),
    cesiumAvailable: true, editEnabled: true,
  }));
  const container = render(<RibbonToolbar />);
  assert.equal(container.querySelectorAll('[role="tab"]').length, TABS.length,
    'the guard visits every ribbon tab');
  const rawByTab: Record<string, number> = {};
  for (const tab of TABS) {
    const trigger = container.querySelectorAll('[role="tab"]')[TABS.indexOf(tab)];
    assert.ok(trigger, `${tab} tab is mounted`);
    mouseDown(trigger, { button: 0 });
    const band = container.querySelector('[role="tabpanel"]');
    assert.ok(band, `${tab} band is mounted`);
    const buttons = [...band.querySelectorAll<HTMLButtonElement>('button')];
    assert.ok(buttons.length > 0, `${tab} has command controls`);
    let raw = 0;
    let panelBrowsers = 0;
    for (const button of buttons) {
      if (button.dataset.ribbonContent === 'panel-browser') {
        assert.equal(tab, 'analyze', 'the panel browser belongs to Analyze');
        assert.equal(button.getAttribute('aria-label'), resolve('shellChrome.panelGroups.browse'));
        panelBrowsers++;
        continue;
      }
      const exportId = button.dataset.exportCommand;
      if (exportId) {
        const exportCommand = EXPORT_COMMANDS.find((item) => item.id === exportId);
        assert.ok(exportCommand, `${tab}: ${exportId} is a registered export`);
        assert.equal(button.getAttribute('aria-label'), resolve(exportCommand.tooltipKey),
          `${tab}: ${exportId} announces its export registry tooltip`);
        continue;
      }
      if (button.dataset.exportExtension || button.dataset.ribbonExtension) continue;
      const id = button.dataset.commandId;
      if (!id) { raw++; continue; }
      const command: SurfaceCommandDefinition | undefined = SURFACE_COMMANDS.find((item) => item.id === id);
      assert.ok(command, `${tab}: ${id} is registered`);
      assert.ok(command.surfaces.includes('ribbon'), `${tab}: ${id} declares the ribbon surface`);
      assert.equal(button.getAttribute('aria-label'), resolve(command.ribbonLabelKey ?? command.labelKey),
        `${tab}: ${id} announces its registry label`);
    }
    assert.equal(panelBrowsers, tab === 'analyze' ? 1 : 0, `${tab}: panel browser trigger count`);
    rawByTab[tab] = raw;
  }
  // The remaining raw controls are a strict migration ratchet: a newly
  // hand-labelled command fails this mounted guard even before its tab is
  // converted to typed IDs. Drop each count to zero with that tab's migration.
  assert.deepEqual(rawByTab, {
    file: 4, home: 0, view: 0, elements: 13, analyze: 0, author: 9,
  });
});
