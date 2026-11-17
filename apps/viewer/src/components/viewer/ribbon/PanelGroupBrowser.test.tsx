/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render';
import { useViewerStore } from '@/store';
import { isCollabEnabled } from '@/lib/collab/config';
import { PANEL_GROUPS, WORKSPACE_PANELS } from '@/lib/panels/registry';
import { PANEL_SURFACE_COMMANDS } from '../surface-commands-panels';
import { ActivityBar } from '../sidebar/ActivityBar';
import { PanelGroupBrowser } from './PanelGroupBrowser';
import { readRailSurface } from '@/test/rail-surface.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import type { FederatedModel } from '@/store/types';

afterEach(() => {
  cleanup();
  useViewerStore.getState().showWorkspacePanel('properties');
  useViewerStore.getState().resetSidebarLayout();
});

it('#5873 renders every available panel once under the same task group in the rail and ribbon', () => {
  const available = WORKSPACE_PANELS.filter((panel) => panel.id !== 'collab' || isCollabEnabled());
  // The rail offers each panel as an icon or, on an empty viewer where the
  // panels that need a model wait there (#8802 R6), as a row of its More menu
  // (`readRailSurface`). Both states: a name or group heading that differs
  // from the ribbon's in either one fails.
  const states: Array<[string, Map<string, FederatedModel>]> = [
    ['empty viewer', new Map()],
    ['model loaded', fixtureModels(fixtureModel('m')).models],
  ];
  for (const [state, models] of states) {
    useViewerStore.setState({ models });
    useViewerStore.getState().setPointCloudAssetCount(0);
    useViewerStore.getState().resetSidebarLayout();
    render(<ActivityBar />);
    const rail = readRailSurface();
    if (state === 'empty viewer') assert.equal(rail.where.get('properties'), 'more', 'the empty viewer\'s More rows are read');

    const ribbon = render(<PanelGroupBrowser />);
    const trigger = ribbon.querySelector<HTMLButtonElement>('button[aria-label="Browse panels"]');
    assert.ok(trigger);
    assert.ok(
      trigger.querySelector('svg[data-testid="icon-stub"]'),
      'the Browse panels trigger must render through the house icon loader, not a Lucide glyph',
    );
    act(() => {
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    click(trigger);

    const menuRows = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"][data-panel-id]')];
    assert.equal(menuRows.length, available.length, state);
    for (const panel of available) {
      const rows = menuRows.filter((row) => row.dataset.panelId === panel.id);
      assert.equal(rows.length, 1, `${panel.id} once in the ribbon (${state})`);
      assert.equal(rail.names.get(panel.id), rows[0].textContent?.trim(), `${panel.id} has one name on the rail and the ribbon (${state})`);
      assert.ok(PANEL_GROUPS.some((group) => group.id === panel.group), panel.id);
    }
    for (const group of PANEL_GROUPS) {
      const menuHeading = document.querySelector<HTMLElement>(`[role="menu"] [data-panel-group="${group.id}"]`);
      assert.equal(rail.groups.get(group.id), menuHeading?.textContent, `${group.id} heading (${state})`);
    }

    if (state === 'model loaded') {
      const scan = menuRows.find((row) => row.dataset.panelId === 'pointclouds');
      assert.ok(scan, 'Point Clouds remains reachable before loading a scan');
      click(scan);
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
    }
    cleanup();
  }
  useViewerStore.setState({ models: new Map() });
});

it('#5873 projects each panel command group from the panel registry', () => {
  const panels = new Map(WORKSPACE_PANELS.map((panel) => [panel.id, panel]));
  for (const command of PANEL_SURFACE_COMMANDS) {
    assert.ok(command.panelId, command.id);
    const panel = panels.get(command.panelId);
    assert.ok(panel, command.id);
    assert.equal(command.panelGroup, panel.group, command.id);
  }
});
