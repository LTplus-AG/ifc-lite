/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, cleanup, mouseDown, press, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry';
import { posthog } from '@/lib/analytics';
import { setCollabEnabledOverride } from '@/lib/collab/config';
import { fixtureDataStore } from '@/test/store-fixture';
import { useViewerStore, type RibbonTabId } from '@/store';
import { SURFACE_COMMANDS, type SurfaceCommandDefinition } from '../surface-commands.js';
import { EXPORT_COMMANDS } from '../toolbar/export-commands.js';
import type { FileCommands } from '../toolbar/useFileCommands.js';
import { RibbonToolbar } from './RibbonToolbar.js';
import { FileTab } from './tabs/FileTab.js';

const TABS: RibbonTabId[] = ['file', 'home', 'view', 'elements', 'analyze', 'author'];
const initialState = useViewerStore.getState();

afterEach(() => {
  mock.restoreAll();
  cleanup();
  setCollabEnabledOverride(null);
  act(() => useViewerStore.setState(initialState));
});

it('#5878 File Share invokes its mounted host once through the registry', () => {
  setCollabEnabledOverride(true);
  let shareOpens = 0;
  const fileCommands: FileCommands = {
    fileInputs: null, openShareDialog: () => { shareOpens++; },
    handleOpenClick: async () => {}, handleAddModelClick: async () => {},
    handleRefresh: async () => {}, canRefresh: false, hasModelsLoaded: true,
  };
  const capture = mock.method(posthog, 'capture', () => undefined);
  const container = render(<FileTab fileCommands={fileCommands} />);
  const share = container.querySelector<HTMLButtonElement>('button[data-command-id="file:share"]');
  assert.ok(share, 'Share is mounted when collaboration is enabled');
  click(share);
  assert.equal(shareOpens, 1, 'Share reaches the live file host exactly once');
  assert.deepEqual(capture.mock.calls.filter((call) => call.arguments[0] === 'command_executed')
    .map((call) => call.arguments), [
    ['command_executed', { command_id: 'file:share', surface: 'ribbon' }],
  ]);
});

it('#5870/#5878 mounts every ribbon command with its registry name across all tabs', () => {
  setCollabEnabledOverride(true);
  act(() => useViewerStore.setState({
    ribbonTab: 'home', ribbonCollapsed: false,
    selectedEntityId: 11, selectedEntityIds: new Set([11]),
    cesiumAvailable: true, cesiumEnabled: true, editEnabled: true,
  }));
  const container = render(<RibbonToolbar />);
  assert.equal(container.querySelectorAll('[role="tab"]').length, TABS.length,
    'the guard visits every ribbon tab');
  const rawByTab: Record<string, number> = {};
  const renderedIds = new Set<string>();
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
        assert.equal(button.dataset.ribbonContentSource, 'panel-browser');
        assert.equal(button.dataset.ribbonContentId, 'panel-browser');
        assert.equal(button.getAttribute('aria-label'), resolve('shellChrome.panelGroups.browse'));
        panelBrowsers++;
        continue;
      }
      const exportId = button.dataset.exportCommand;
      if (exportId) {
        assert.equal(button.dataset.ribbonContentSource, 'export', `${tab}: ${exportId} declares its export owner`);
        assert.equal(button.dataset.ribbonContentId, exportId, `${tab}: ${exportId} carries its export registry id`);
        const exportCommand = EXPORT_COMMANDS.find((item) => item.id === exportId);
        assert.ok(exportCommand, `${tab}: ${exportId} is a registered export`);
        assert.equal(button.getAttribute('aria-label'), resolve(exportCommand.tooltipKey),
          `${tab}: ${exportId} announces its export registry tooltip`);
        continue;
      }
      const extensionId = button.dataset.exportExtension ?? button.dataset.ribbonExtension;
      if (extensionId) {
        assert.equal(button.dataset.ribbonContentSource, 'extension', `${tab}: ${extensionId} declares its extension owner`);
        assert.equal(button.dataset.ribbonContentId, extensionId, `${tab}: ${extensionId} carries its contribution id`);
        continue;
      }
      const id = button.dataset.commandId;
      if (!id) { raw++; continue; }
      assert.equal(button.dataset.ribbonContentSource, 'registered', `${tab}: ${id} is a registered button`);
      assert.equal(button.dataset.ribbonContentId, id, `${tab}: ${id} matches its typed command id`);
      renderedIds.add(id);
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
    file: 0, home: 0, view: 0, elements: 0, analyze: 0, author: 0,
  });
  assert.deepEqual(renderedIds,
    new Set(SURFACE_COMMANDS.filter((command) => command.surfaces.includes('ribbon'))
      .map((command) => command.id)),
    'every ribbon-declared command is mounted on one of its six tabs');
});

it('#5878 enabled collaboration File controls use registered names', () => {
  setCollabEnabledOverride(true);
  act(() => useViewerStore.setState({ ribbonTab: 'file', ribbonCollapsed: false }));
  const container = render(<RibbonToolbar />);
  const band = container.querySelector('[role="tabpanel"]');
  assert.ok(band);
  const buttons = [...band.querySelectorAll<HTMLButtonElement>('button')];
  const commandIds = buttons.map((button) => button.dataset.commandId);
  assert.ok(commandIds.includes('file:share'));
  assert.ok(commandIds.includes('panel:collab'));
  for (const button of buttons) {
    if (button.dataset.exportExtension) continue;
    if (button.dataset.exportCommand) {
      const exportCommand = EXPORT_COMMANDS.find((item) => item.id === button.dataset.exportCommand);
      assert.ok(exportCommand);
      assert.equal(button.getAttribute('aria-label'), resolve(exportCommand.tooltipKey));
      continue;
    }
    const id = button.dataset.commandId;
    assert.ok(id, 'collaboration adds no raw File command controls');
    const command: SurfaceCommandDefinition | undefined = SURFACE_COMMANDS.find((item) => item.id === id);
    assert.ok(command);
    assert.ok(command.surfaces.includes('ribbon'));
    assert.equal(button.getAttribute('aria-label'), resolve(command.ribbonLabelKey ?? command.labelKey));
  }
});

it('#5878 Elements commands act through the mounted ribbon and class filter opens its menu', () => {
  act(() => useViewerStore.setState({
    ribbonTab: 'elements', ribbonCollapsed: false,
    hierarchyMode: 'spatial', leftPanelCollapsed: true,
    hoverTooltipsEnabled: false, searchModalOpen: false, searchModalTab: 'filter',
  }));
  const container = render(<RibbonToolbar />);
  const control = (id: string): HTMLButtonElement => {
    const button = container.querySelector<HTMLButtonElement>(`button[data-command-id="${id}"]`);
    assert.ok(button, `${id} is mounted`);
    return button;
  };

  click(control('elements:type'));
  assert.equal(useViewerStore.getState().hierarchyMode, 'ifc-type');
  assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
  click(control('pref:tooltips'));
  assert.equal(useViewerStore.getState().hoverTooltipsEnabled, true);
  click(control('elements:search'));
  assert.equal(useViewerStore.getState().searchModalOpen, true);
  assert.equal(useViewerStore.getState().searchModalTab, 'search');

  const filter = control('elements:class-filter');
  assert.equal(filter.dataset.commandTrigger, 'true');
  assert.equal(filter.getAttribute('aria-haspopup'), 'menu');
  const capture = mock.method(posthog, 'capture', () => undefined);
  act(() => filter.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  click(filter);
  assert.equal(filter.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(capture.mock.calls.filter((call) => call.arguments[0] === 'command_executed')
    .map((call) => call.arguments), [
    ['command_executed', { command_id: 'elements:class-filter', surface: 'ribbon' }],
  ]);
});

it('#5878 keyboard opening of the class filter emits one registered command event', () => {
  act(() => useViewerStore.setState({ ribbonTab: 'elements', ribbonCollapsed: false }));
  const container = render(<RibbonToolbar />);
  const filter = container.querySelector<HTMLButtonElement>('button[data-command-id="elements:class-filter"]');
  assert.ok(filter);
  const capture = mock.method(posthog, 'capture', () => undefined);
  press(filter, 'Enter');
  assert.equal(filter.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(capture.mock.calls.filter((call) => call.arguments[0] === 'command_executed')
    .map((call) => call.arguments), [
    ['command_executed', { command_id: 'elements:class-filter', surface: 'ribbon' }],
  ]);
});

it('#5878 Author edit and Space Sketch execute through registered ribbon controls', () => {
  act(() => useViewerStore.setState({
    ribbonTab: 'author', ribbonCollapsed: false,
    editEnabled: false, activeTool: 'select', collabRole: null,
  }));
  const container = render(<RibbonToolbar />);
  const control = (id: string): HTMLButtonElement => {
    const button = container.querySelector<HTMLButtonElement>(`button[data-command-id="${id}"]`);
    assert.ok(button, `${id} is mounted`);
    return button;
  };
  click(control('tool:edit-mode'));
  assert.equal(useViewerStore.getState().editEnabled, true);
  click(control('author:space-sketch'));
  assert.equal(useViewerStore.getState().activeTool, 'spaceSketch');
  assert.equal(control('author:bulk-properties').dataset.commandTrigger, 'true');
  assert.equal(control('author:import-data').dataset.commandTrigger, 'true');
});

it('#5878 Author dialog trigger opens once and records its registered command', () => {
  act(() => useViewerStore.setState({
    ribbonTab: 'author', ribbonCollapsed: false, ifcDataStore: fixtureDataStore(),
  }));
  const container = render(<RibbonToolbar />);
  const trigger = container.querySelector<HTMLButtonElement>('button[data-command-id="author:bulk-properties"]');
  assert.ok(trigger);
  assert.equal(trigger.disabled, false);
  const capture = mock.method(posthog, 'capture', () => undefined);
  click(trigger);
  assert.ok(document.querySelector('[role="dialog"]'), 'the mounted Bulk Property Editor opens');
  assert.deepEqual(capture.mock.calls.filter((call) => call.arguments[0] === 'command_executed')
    .map((call) => call.arguments), [
    ['command_executed', { command_id: 'author:bulk-properties', surface: 'ribbon' }],
  ]);
});
