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

afterEach(() => {
  cleanup();
  useViewerStore.getState().showWorkspacePanel('properties');
  useViewerStore.getState().resetSidebarLayout();
});

it('#5873 renders every available panel once under the same task group in the rail and ribbon', () => {
  useViewerStore.getState().setPointCloudAssetCount(0);
  useViewerStore.getState().resetSidebarLayout();
  render(<ActivityBar />);
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

  const available = WORKSPACE_PANELS.filter((panel) => panel.id !== 'collab' || isCollabEnabled());
  const menuRows = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"][data-panel-id]')];
  const railButtons = [...document.querySelectorAll<HTMLElement>('[data-activity-bar] button[aria-label]')];
  assert.equal(menuRows.length, available.length);
  for (const panel of available) {
    assert.equal(menuRows.filter((row) => row.dataset.panelId === panel.id).length, 1, panel.id);
    assert.equal(railButtons.filter((button) => button.getAttribute('aria-label') === menuRows.find((row) => row.dataset.panelId === panel.id)?.textContent?.trim()).length, 1, panel.id);
    assert.ok(PANEL_GROUPS.some((group) => group.id === panel.group), panel.id);
  }
  for (const group of PANEL_GROUPS) {
    const railHeading = document.querySelector<HTMLElement>(`[data-activity-bar] [data-panel-group="${group.id}"]`);
    const menuHeading = document.querySelector<HTMLElement>(`[role="menu"] [data-panel-group="${group.id}"]`);
    assert.equal(railHeading?.textContent, menuHeading?.textContent, group.id);
  }

  const scan = menuRows.find((row) => row.dataset.panelId === 'pointclouds');
  assert.ok(scan, 'Point Clouds remains reachable before loading a scan');
  click(scan);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
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
